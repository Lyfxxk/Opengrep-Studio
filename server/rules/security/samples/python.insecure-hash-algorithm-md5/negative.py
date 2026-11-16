import cryptography.hazmat.primitives.hashes


def modern_hash():
    return cryptography.hazmat.primitives.hashes.SHA256()
