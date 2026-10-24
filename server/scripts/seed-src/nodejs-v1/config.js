// 支付网关配置（演示项目：刻意包含安全问题，用于验证扫描规则）
const apiKey = "sk_demo_51H8xQz2ZvzluDecomIKtGp5XqXfEYbA3Z04vB9dQ";
const dbPassword = "Pr0d-Pay-2026-Local";
const jwtSecret = "demo-jwt-signing-secret-do-not-use-in-prod";
const maxRetry = 3;

module.exports = { apiKey, dbPassword, jwtSecret, maxRetry };
