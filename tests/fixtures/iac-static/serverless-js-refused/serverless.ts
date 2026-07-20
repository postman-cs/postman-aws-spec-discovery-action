// Intentionally JS/TS Serverless config — must never be loaded or executed.
module.exports = {
  service: 'orders',
  provider: { name: 'aws', runtime: 'nodejs20.x' }
};
