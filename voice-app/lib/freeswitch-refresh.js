/**
 * FreeSWITCH Advertised IP Refresh
 *
 * Best-effort recovery after a public IP change: FreeSWITCH bakes its
 * advertised RTP address (ext-rtp-ip) in when a Sofia profile starts, so new
 * calls keep advertising the old address until the profile restarts. This
 * helper updates the external_rtp_ip variable and restarts the running Sofia
 * profiles through the existing event socket connection.
 *
 * When docker-compose runs with PUBLIC_IP=auto, ext-rtp-ip is configured as a
 * stun: reference, which FreeSWITCH re-resolves on profile restart, so the
 * restart alone picks up the new address even if the variable is unused.
 *
 * Every step is logged; on failure the operator is told to restart the stack.
 */

var logger = require('./logger');

/**
 * Parse profile names out of a `sofia status` response.
 * Lines look like: "  drachtio_mrf    profile    sip:mod_sofia@1.2.3.4:5080    RUNNING (0)"
 * @param {string} statusBody
 * @returns {string[]}
 */
function parseProfileNames(statusBody) {
  var names = [];
  var lines = String(statusBody || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var cols = lines[i].trim().split(/\s+/);
    if (cols.length >= 4 && cols[1] === 'profile' && lines[i].indexOf('RUNNING') !== -1) {
      names.push(cols[0]);
    }
  }
  return names;
}

/**
 * Push a new public IP into the running FreeSWITCH (best effort).
 * @param {Object} mediaServer - drachtio-fsmrf MediaServer (api() available)
 * @param {string} newIp - The newly detected public IP
 * @returns {Promise<boolean>} true if the profiles were restarted
 */
async function refreshAdvertisedIp(mediaServer, newIp) {
  if (!mediaServer || typeof mediaServer.api !== 'function') {
    logger.warn('FreeSWITCH refresh skipped: media server not connected. Restart the stack to restore audio.');
    return false;
  }

  try {
    var status = await mediaServer.api('sofia status');
    var profiles = parseProfileNames(status);
    if (profiles.length === 0) {
      logger.warn('FreeSWITCH refresh: no running Sofia profiles found. Restart the stack to restore audio.');
      return false;
    }

    var setvarRes = await mediaServer.api('global_setvar external_rtp_ip=' + newIp);
    logger.info('FreeSWITCH global_setvar external_rtp_ip', { newIp: newIp, result: String(setvarRes).trim() });

    var reloadRes = await mediaServer.api('reloadxml');
    logger.info('FreeSWITCH reloadxml', { result: String(reloadRes).trim().split('\n')[0] });

    for (var i = 0; i < profiles.length; i++) {
      var restartRes = await mediaServer.api('sofia profile ' + profiles[i] + ' restart');
      logger.info('FreeSWITCH profile restarted', {
        profile: profiles[i],
        result: String(restartRes).trim().split('\n')[0]
      });
    }

    logger.info('FreeSWITCH advertised IP refresh complete', { newIp: newIp, profiles: profiles });
    return true;
  } catch (err) {
    logger.error('FreeSWITCH refresh failed. Restart the stack to restore audio.', {
      newIp: newIp,
      error: err.message
    });
    return false;
  }
}

module.exports = { refreshAdvertisedIp, parseProfileNames };
