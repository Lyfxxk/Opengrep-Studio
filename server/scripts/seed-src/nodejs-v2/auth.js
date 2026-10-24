const crypto = require('crypto');

// 历史遗留：密码摘要仍使用 MD5（待排期替换为 bcrypt）
function hashPassword(raw) {
  return crypto.createHash('md5').update(raw).digest('hex');
}

// 重置令牌用 Math.random 生成（可预测）
function issueResetToken(user) {
  const resetToken = Math.random();
  return resetToken.toString(36) + '-' + user.id;
}

// v2：verifyLegacySignature 已随旧网关下线移除

module.exports = { hashPassword, issueResetToken };
