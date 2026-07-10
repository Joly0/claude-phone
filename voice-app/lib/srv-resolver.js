/**
 * SRV Record Resolver
 *
 * Resolves SIP registrar hostnames via DNS SRV records, with support for
 * a custom DNS server (needed for providers whose SRV records only resolve
 * through the local router's DNS, not through public resolvers).
 *
 * Falls back to the original hostname if no SRV records are found.
 */

var dns = require('dns');
var dgram = require('dgram');

var DNS_SERVER = process.env.DNS_SERVER || null;
var SRV_TTL_REFRESH_MARGIN = 0.9;

/**
 * Resolve SRV records for a SIP registrar.
 *
 * Tries _sips._tcp.<host> for TLS, _sip._tcp/<udp> for TCP/UDP.
 * Returns targets sorted by priority (lowest first), then randomized by weight.
 *
 * @param {string} host - The registrar hostname
 * @param {string} transport - 'udp', 'tcp', or 'tls'
 * @returns {Promise<Array<{host: string, port: number, ttl: number}>>}
 */
function resolveSrv(host, transport) {
  var srvName;
  if (transport === 'tls') {
    srvName = '_sips._tcp.' + host;
  } else if (transport === 'tcp') {
    srvName = '_sip._tcp.' + host;
  } else {
    srvName = '_sip._udp.' + host;
  }

  if (DNS_SERVER) {
    return resolveSrvCustomDns(srvName, DNS_SERVER);
  }

  return new Promise(function(resolve, reject) {
    dns.resolveSrv(srvName, function(err, records) {
      if (err) {
        reject(err);
        return;
      }
      resolve(sortSrvRecords(records));
    });
  });
}

/**
 * Resolve SRV records using a custom DNS server via raw UDP query.
 * Node's dns module doesn't support per-query DNS server selection.
 */
function resolveSrvCustomDns(srvName, dnsServer) {
  return new Promise(function(resolve, reject) {
    var parts = dnsServer.split(':');
    var serverHost = parts[0];
    var serverPort = parseInt(parts[1]) || 53;

    var packet = buildSrvQuery(srvName);
    var socket = dgram.createSocket('udp4');
    var timeout;

    socket.on('message', function(msg) {
      clearTimeout(timeout);
      socket.close();
      try {
        var records = parseSrvResponse(msg);
        resolve(sortSrvRecords(records));
      } catch (e) {
        reject(e);
      }
    });

    socket.on('error', function(err) {
      clearTimeout(timeout);
      socket.close();
      reject(err);
    });

    timeout = setTimeout(function() {
      socket.close();
      reject(new Error('DNS query timeout for ' + srvName + ' via ' + dnsServer));
    }, 5000);

    socket.send(packet, 0, packet.length, serverPort, serverHost);
  });
}

/**
 * Build a DNS query packet for SRV records
 */
function buildSrvQuery(name) {
  // Header: 12 bytes
  var id = Math.floor(Math.random() * 65535);
  var header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);       // Transaction ID
  header.writeUInt16BE(0x0100, 2);   // Flags: standard query, recursion desired
  header.writeUInt16BE(1, 4);        // Questions: 1
  header.writeUInt16BE(0, 6);        // Answers: 0
  header.writeUInt16BE(0, 8);        // Authority: 0
  header.writeUInt16BE(0, 10);       // Additional: 0

  // Question section
  var labels = name.split('.');
  var questionParts = [];
  for (var i = 0; i < labels.length; i++) {
    var label = Buffer.from(labels[i], 'ascii');
    var lenBuf = Buffer.alloc(1);
    lenBuf.writeUInt8(label.length, 0);
    questionParts.push(lenBuf);
    questionParts.push(label);
  }
  questionParts.push(Buffer.alloc(1)); // Root label (0)

  var typeBuf = Buffer.alloc(4);
  typeBuf.writeUInt16BE(33, 0);  // Type: SRV (33)
  typeBuf.writeUInt16BE(1, 2);   // Class: IN (1)
  questionParts.push(typeBuf);

  return Buffer.concat([header].concat(questionParts));
}

/**
 * Parse a DNS response packet and extract SRV records
 */
function parseSrvResponse(msg) {
  var answerCount = msg.readUInt16BE(6);
  var records = [];

  // Skip header (12 bytes) and question section
  var offset = 12;
  // Skip question section
  while (msg[offset] !== 0) {
    if ((msg[offset] & 0xC0) === 0xC0) {
      offset += 2;
      break;
    }
    offset += msg[offset] + 1;
  }
  if (msg[offset] === 0) offset += 1;
  offset += 4; // Type + Class

  // Parse answer section
  for (var i = 0; i < answerCount; i++) {
    // Skip name (may be compressed)
    var nameResult = skipName(msg, offset);
    offset = nameResult;

    var type = msg.readUInt16BE(offset);
    offset += 2;
    // skip class
    offset += 2;
    var ttl = msg.readUInt32BE(offset);
    offset += 4;
    var rdlength = msg.readUInt16BE(offset);
    offset += 2;

    if (type === 33) { // SRV
      var priority = msg.readUInt16BE(offset);
      var weight = msg.readUInt16BE(offset + 2);
      var port = msg.readUInt16BE(offset + 4);
      var targetResult = readName(msg, offset + 6);
      var target = targetResult.name;

      records.push({
        priority: priority,
        weight: weight,
        port: port,
        name: target,
        host: target,
        ttl: ttl
      });
    }

    offset += rdlength;
  }

  return records;
}

/**
 * Skip a DNS name at offset, return new offset
 */
function skipName(msg, offset) {
  while (offset < msg.length) {
    if (msg[offset] === 0) return offset + 1;
    if ((msg[offset] & 0xC0) === 0xC0) return offset + 2;
    offset += msg[offset] + 1;
  }
  return offset;
}

/**
 * Read a DNS name at offset, following compression pointers
 */
function readName(msg, offset) {
  var parts = [];
  var jumped = false;
  var returnOffset = offset;

  while (offset < msg.length) {
    var len = msg[offset];
    if (len === 0) {
      if (!jumped) returnOffset = offset + 1;
      break;
    }
    if ((len & 0xC0) === 0xC0) {
      if (!jumped) returnOffset = offset + 2;
      offset = ((len & 0x3F) << 8) | msg[offset + 1];
      jumped = true;
      continue;
    }
    parts.push(msg.toString('ascii', offset + 1, offset + 1 + len));
    offset += len + 1;
  }

  return { name: parts.join('.'), offset: returnOffset };
}

/**
 * Sort SRV records by priority (ascending), then shuffle by weight within each priority group
 */
function sortSrvRecords(records) {
  // Group by priority
  var groups = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (!groups[r.priority]) groups[r.priority] = [];
    groups[r.priority].push(r);
  }

  var sorted = [];
  var priorities = Object.keys(groups).sort(function(a, b) { return a - b; });

  for (var p = 0; p < priorities.length; p++) {
    var group = groups[priorities[p]];
    // Weighted random selection within priority group
    while (group.length > 0) {
      var totalWeight = 0;
      for (var j = 0; j < group.length; j++) {
        totalWeight += group[j].weight || 1;
      }
      var rand = Math.random() * totalWeight;
      var cumulative = 0;
      for (var k = 0; k < group.length; k++) {
        cumulative += group[k].weight || 1;
        if (rand <= cumulative) {
          sorted.push({
            host: group[k].host || group[k].name,
            port: group[k].port,
            ttl: group[k].ttl || 3600
          });
          group.splice(k, 1);
          break;
        }
      }
    }
  }

  return sorted;
}

/**
 * High-level: resolve the registrar, trying SRV first, falling back to the hostname as-is.
 *
 * @param {string} host - Registrar hostname
 * @param {number} port - Configured port (used as fallback)
 * @param {string} transport - 'udp', 'tcp', or 'tls'
 * @returns {Promise<{targets: Array<{host: string, port: number}>, ttl: number}>}
 */
function resolveRegistrar(host, port, transport) {
  return resolveSrv(host, transport)
    .then(function(records) {
      if (records.length === 0) {
        console.log('[SRV-RESOLVER] No SRV records for ' + host + ', using as-is');
        return { targets: [{ host: host, port: port }], ttl: 3600 };
      }
      var minTtl = records[0].ttl;
      for (var i = 1; i < records.length; i++) {
        if (records[i].ttl < minTtl) minTtl = records[i].ttl;
      }
      console.log('[SRV-RESOLVER] Resolved ' + host + ' to ' + records.length + ' targets (TTL ' + minTtl + 's):');
      for (var j = 0; j < records.length; j++) {
        console.log('[SRV-RESOLVER]   ' + (j + 1) + '. ' + records[j].host + ':' + records[j].port);
      }
      return {
        targets: records.map(function(r) { return { host: r.host, port: r.port }; }),
        ttl: Math.floor(minTtl * SRV_TTL_REFRESH_MARGIN)
      };
    })
    .catch(function(err) {
      console.log('[SRV-RESOLVER] SRV lookup failed for ' + host + ' (' + err.message + '), using as-is');
      return { targets: [{ host: host, port: port }], ttl: 3600 };
    });
}

module.exports = {
  resolveSrv: resolveSrv,
  resolveRegistrar: resolveRegistrar
};
