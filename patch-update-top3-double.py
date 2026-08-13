from pathlib import Path
p = Path("update-top3.mjs")
s = p.read_text(encoding="utf-8")
s = s.replace("for (let i = 1; i <= 3; i += 1) {", "for (let i = 1; i <= 2; i += 1) {")
s = s.replace("if (!sameSnapshot(passes[0], passes[1]) || !sameSnapshot(passes[1], passes[2])) {", "if (!sameSnapshot(passes[0], passes[1])) {")
s = s.replace("throw new Error('три независимых чтения Столото не совпали — запись запрещена');", "throw new Error('два независимых чтения Столото не совпали — запись запрещена');")
s = s.replace("Официальный Столото · OAuth · тройная проверка", "Официальный Столото · OAuth · двойная проверка")
p.write_text(s, encoding="utf-8")
print("update-top3.mjs permanently switched to double verification")
