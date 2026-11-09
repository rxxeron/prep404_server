const fs = require('fs');
let text = fs.readFileSync('lib/features/dashboard/presentation/widgets/profile_dialogs.dart', 'utf8');

// What if there is a multi-line string in profile_dialogs.dart?
let cleaned = text.replace(/\/\/.*$/gm, '')
                  .replace(/\/\*[\s\S]*?\*\//g, '')
                  .replace(/'''[\s\S]*?'''/g, '')
                  .replace(/"""[\s\S]*?"""/g, '')
                  .replace(/'(?:[^'\\]|\\.)*'/g, '')
                  .replace(/"(?:[^"\\]|\\.)*"/g, '');

let b = 0, p = 0, bk = 0;
for (let i = 0; i < cleaned.length; i++) {
  const c = cleaned[i];
  if (c === '{') b++;
  if (c === '}') b--;
  if (c === '[') bk++;
  if (c === ']') bk--;
  if (c === '(') p++;
  if (c === ')') p--;
}
console.log('Cleaned total:', { b, bk, p });

// Let's inspect where quotes or multi-line strings are in profile_dialogs.dart:
const lines = text.split(/\r?\n/);
lines.forEach((l, i) => {
  if (l.includes("'") || l.includes('"')) {
    const singleQuotes = (l.match(/'/g) || []).length;
    const doubleQuotes = (l.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
      console.log(`Odd quotes on line ${i + 1}: ${l}`);
    }
  }
});
