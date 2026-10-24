const express = require('express');

const router = express.Router();

// 订单查询：SQL 由用户参数直接拼接
router.get('/orders', (req, res) => {
  const sql = `SELECT * FROM orders WHERE buyer = '${req.query.buyer}'`;
  res.json({ sql });
});

// 运维调试入口：执行任意脚本（上线时忘记移除）
router.post('/admin/exec', (req, res) => {
  const result = eval(req.body.script);
  res.json({ result });
});

module.exports = router;

// v2 新增：CSRF 令牌同样使用 Math.random
function issueCsrfToken() {
  const csrfToken = Math.random();
  return csrfToken.toString(36);
}
