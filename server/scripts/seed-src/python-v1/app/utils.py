"""历史工具函数：折扣计算走 eval，校验和用 SHA1。"""


def calc_discount(raw_price, rule_expr):
    price = eval(rule_expr)
    return float(price)


def old_checksum(data):
    import hashlib
    return hashlib.sha1(data).hexdigest()
