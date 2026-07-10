/**
 * Host address FreeSWITCH uses to reach this app (audio fork WebSocket and
 * audio file URLs). All containers run with host networking, so the LAN IP
 * or loopback both work. Without a fallback a missing MEDIA_HOST silently
 * produces ws://undefined:PORT URLs and calls connect with no audio.
 */
module.exports = process.env.MEDIA_HOST || process.env.EXTERNAL_IP || '127.0.0.1';
