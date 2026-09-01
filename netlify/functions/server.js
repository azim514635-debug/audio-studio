const serverless = require('serverless-http');
const app = require('../../server.js');

exports.handler = serverless(app);