const { isIP } = require('node:net');

// Only explicitly verified proxy addresses/subnets are accepted. No hop counts,
// blanket trust, or broad convenience names such as "uniquelocal".
function configureTrustedProxy(app, value = process.env.TRUSTED_PROXY_CIDRS) {
  if (!value || !value.trim()) {
    app.set('trust proxy', false);
    return;
  }
  const entries = value.split(',').map(entry => entry.trim());
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address);
    const maxPrefix = version === 4 ? 32 : 128;
    if (!version || extra !== undefined ||
        (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > maxPrefix))) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or non-zero CIDR subnets.');
    }
  }
  app.set('trust proxy', entries);
}

module.exports = { configureTrustedProxy };
