import cryptography.hazmat.primitives.hashes


def legacy_hash():
    return cryptography.hazmat.primitives.hashes.MD5()
