import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeUploadFileName } from '../src/routes/shared.ts';

test('latin1 乱码形态的中文文件名按 UTF-8 还原', () => {
  const original = 'E2E-JS规则包.yaml';
  const mojibake = Buffer.from(original, 'utf8').toString('latin1');
  assert.equal(decodeUploadFileName(mojibake), original);
});

test('已是正常 UTF-8 / ASCII 的文件名原样返回', () => {
  assert.equal(decodeUploadFileName('E2E-JS规则包.yaml'), 'E2E-JS规则包.yaml');
  assert.equal(decodeUploadFileName('report.sarif'), 'report.sarif');
  assert.equal(decodeUploadFileName('café.txt'), 'café.txt');
});
