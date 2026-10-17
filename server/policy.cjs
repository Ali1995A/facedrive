const policy = { scope: 'voice-token-issuance', perMinute: 12, perDay: 300, concurrent: 4, maxBodyBytes: 1024 };
module.exports = { policy };
