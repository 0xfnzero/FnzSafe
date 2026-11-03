import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { detectLocale, translate } from '../src/ui/i18n';
import zhCN from '../src/ui/locales/zh-CN.json';
import zhTW from '../src/ui/locales/zh-TW.json';

test('language detection, placeholders, and untranslated user data remain stable', () => {
  assert.equal(detectLocale('zh-Hant-HK'), 'zh-TW'); assert.equal(detectLocale('zh-TW'), 'zh-TW');
  assert.equal(detectLocale('zh-CN'), 'zh-CN'); assert.equal(detectLocale('ja'), 'en');
  assert.equal(translate('zh-CN', 'Send {symbol}', { symbol: 'ETH' }), '发送 ETH');
  assert.equal(translate('zh-TW', 'Wallets'), '錢包');
  assert.equal(translate('en', 'Wallets'), 'Wallets');
  assert.equal(translate('zh-CN', '0xabcdef'), '0xabcdef');
  assert.deepEqual(Object.keys(zhCN), Object.keys(zhTW));
});
test('every literal UI translation key exists in both Chinese catalogs', () => {
  const directory = new URL('../src/ui/', import.meta.url);
  const missing = new Set<string>();
  for (const file of readdirSync(directory).filter(f => f.endsWith('.tsx'))) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, directory), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 't' && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text;
        if (!(key in zhCN) || !(key in zhTW)) missing.add(key);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.deepEqual([...missing], []);
});
