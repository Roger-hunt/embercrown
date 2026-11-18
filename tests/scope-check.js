'use strict';
// 静态检查（不启动浏览器）：
//   1. public/index.html 的内联脚本与 server.js 语法正确
//   2. 没有「在同一函数作用域里先用后声明」的 let/const（TDZ）—— 运行到那一行就抛 ReferenceError，
//      typeof 也救不了。2026-11-15 的大招卡死、11-17 CF 版卡在「正在加载资源 0%」都是这一类
//   3. 没有「把局部变量当函数调用、而它遮蔽了外层同名函数」（如局部 const t 遮蔽翻译函数 t()）
// 用法：node tests/scope-check.js [文件 ...]      默认检查 public/index.html 和 server.js
// 依赖 espree + eslint-scope（装了 eslint 就有）；找不到时以 77 退出（算跳过）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, findModule } = require('./lib');

function inlineScript(html) {                          // 取最大的内联 <script>，前面补空行以保持行号与 html 一致
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m, best = null;
  while ((m = re.exec(html))) if (!best || m[1].length > best[1].length) best = m;
  if (!best) throw new Error('没找到内联脚本');
  const startLine = html.slice(0, best.index + best[0].indexOf(best[1])).split('\n').length - 1;
  return '\n'.repeat(startLine) + best[1];
}
function analyse(code, espree, escope) {
  const ast = espree.parse(code, { ecmaVersion: 2022, sourceType: 'script', loc: true, range: true });
  const sm = escope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const lines = code.split('\n');
  const fnScope = s => { while (s && !['function', 'global', 'module', 'class-static-block'].includes(s.type)) s = s.upper; return s; };
  const at = n => n.loc.start.line + ':' + (n.loc.start.column + 1), src = n => lines[n.loc.start.line - 1].trim().slice(0, 140);
  const callee = new Set();
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier') callee.add(n.callee);
    for (const k in n) { if (k === 'loc' || k === 'range') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  })(ast);
  const out = [];
  for (const scope of sm.scopes) for (const ref of scope.references) {
    const v = ref.resolved; if (!v || !v.defs.length) continue;
    const def = v.defs[0];
    const lexical = def.type === 'ClassName' || (def.type === 'Variable' && def.parent && (def.parent.kind === 'let' || def.parent.kind === 'const'));
    if (lexical && !ref.init && ref.identifier.range[0] < def.name.range[0] && fnScope(ref.from) === fnScope(v.scope))
      out.push('先用后声明  L' + at(ref.identifier) + '  `' + v.name + '`（声明在 L' + at(def.name) + '）\n      ' + src(ref.identifier));
    if (callee.has(ref.identifier) && def.type === 'Variable' && !(def.node.init && /Function/.test(def.node.init.type))) {
      let up = v.scope.upper, outer = null; while (up && !outer) { outer = up.set.get(v.name) || null; up = up.upper; }
      if (outer) out.push('遮蔽后调用  L' + at(ref.identifier) + '  `' + v.name + '(…)` 解析到 L' + at(def.name) + ' 的局部变量，外层同名定义在 L' + at(outer.defs[0].name) + '\n      ' + src(ref.identifier));
    }
  }
  return [...new Set(out)];
}
let espree, escope;
try { espree = findModule('espree', 'EC_ESPREE'); escope = findModule('eslint-scope', 'EC_ESLINT_SCOPE'); }
catch (e) { console.log('SKIP ' + e.message); process.exit(77); }
const files = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(ROOT, 'public/index.html'), path.join(ROOT, 'server.js')];
let bad = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8'), code = /\.html?$/i.test(f) ? inlineScript(raw) : raw.replace(/^#!.*/, '');
  const name = path.relative(ROOT, f) || f;
  try { new vm.Script(code, { filename: name }); } catch (e) { bad++; console.log('FAIL ' + name + ' 语法错误: ' + e.message); continue; }
  let probs; try { probs = analyse(code, espree, escope); } catch (e) { bad++; console.log('FAIL ' + name + ' 无法解析: ' + e.message); continue; }
  if (probs.length) { bad++; console.log('FAIL ' + name + ': ' + probs.length + ' 处作用域问题'); for (const p of probs) console.log('  ' + p); }
  else console.log('PASS ' + name + ' 语法正确，没有先用后声明或遮蔽调用');
}
process.exit(bad ? 1 : 0);
