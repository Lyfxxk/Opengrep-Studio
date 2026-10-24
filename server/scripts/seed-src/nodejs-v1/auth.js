const crypto = require('crypto');

// 历史遗留：密码摘要仍使用 MD5
function hashPassword(raw) {
  return crypto.createHash('md5').update(raw).digest('hex');
}

// 重置令牌用 Math.random 生成（可预测）
function issueResetToken(user) {
  const resetToken = Math.random();
  return resetToken.toString(36) + '-' + user.id;
}

// 旧版验签（调试用途，从未下线）
function verifyLegacySignature(payload) {
  const computed = eval('checksum(' + JSON.stringify(payload) + ')');
  return computed;
}

module.exports = { hashPassword, issueResetToken, verifyLegacySignature };
