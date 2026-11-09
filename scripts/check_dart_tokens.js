const fs = require('fs');

const file = 'lib/features/practice_map/presentation/screens/admission_hiking_roadmap_screen.dart';
let text = fs.readFileSync(file, 'utf8');

// Strip single line comments
text = text.replace(/\/\/.*$/gm, '');
// Strip multi line comments
text = text.replace(/\/\*[\s\S]*?\*\//g, '');
// Strip triple quoted strings
text = text.replace(/'''[\s\S]*?'''/g, '');
text = text.replace(/"""[\s\S]*?"""/g, '');
// Strip single quoted strings
text = text.replace(/'(?:[^'\\]|\\.)*'/g, '');
// Strip double quoted strings
text = text.replace(/"(?:[^"\\]|\\.)*"/g, '');

let b = 0, p = 0, bk = 0;
for (let c of text) {
  if (c === '{') b++;
  if (c === '}') b--;
  if (c === '(') p++;
  if (c === ')') p--;
  if (c === '[') bk++;
  if (c === ']') bk--;
}

console.log('Stripped comment/string counts:');
console.log('Braces:', b);
console.log('Parens:', p);
console.log('Brackets:', bk);
