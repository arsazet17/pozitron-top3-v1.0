import assert from 'node:assert/strict';

const mod10 = n => ((Number(n) % 10) + 10) % 10;
const mirrorDigit = n => mod10(10 - n);
const mirror = arr => arr.map(mirrorDigit);

function perms(values) {
  const a = [...values];
  const out = new Set();
  const walk = (i) => {
    if (i === a.length - 1) { out.add(a.join('')); return; }
    const used = new Set();
    for (let j=i;j<a.length;j++) {
      if (used.has(a[j])) continue;
      used.add(a[j]);
      [a[i],a[j]]=[a[j],a[i]];
      walk(i+1);
      [a[i],a[j]]=[a[j],a[i]];
    }
  };
  walk(0);
  return [...out].sort();
}

const add = (x,y) => x.map((n,i)=>mod10(n+y[i]));

assert.deepEqual(mirror([7,3,3]), [3,7,7], '733 должно зеркалиться в 377');
assert.deepEqual(perms([7,3,3]), ['337','373','733'], 'У 733 должно быть 3 уникальных перестановки');
assert.equal(add([9,3,0],[2,8,1]).join(''), '111', '930 + 281 должно дать 111');
assert.equal(mirror([5,2,2]).join(''), '588', '522 должно зеркалиться в 588');

console.log('OK: зеркало, перестановки и mod10 работают правильно.');
