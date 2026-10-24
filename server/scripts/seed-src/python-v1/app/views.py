"""演示项目：刻意包含安全问题，用于验证扫描规则。"""
import base64
import hashlib
import pickle

from flask import Flask, jsonify, request

app = Flask(__name__)

DB_PASSWORD = "flask-blog-pass-2026-local"


def get_cursor():
    raise NotImplementedError


@app.route('/posts')
def search_posts():
    keyword = request.args.get('q', '')
    cursor = get_cursor()
    cursor.execute("SELECT * FROM posts WHERE title LIKE '%" + keyword + "%' ORDER BY id")
    return jsonify(cursor.fetchall())


@app.route('/session/restore')
def restore_session():
    raw = request.args.get('session', '')
    session = pickle.loads(base64.b64decode(raw))
    return jsonify(session)


def sign_download(filename):
    return hashlib.md5(filename.encode()).hexdigest()
