const iconv = require("iconv-lite");

const MOJIBAKE_MARKERS = [
  /姝ｅ湪/g,
  /浠诲姟/g,
  /瀹屾垚/g,
  /璁板綍/g,
  /淇/g,
  /绛夊緟/g,
  /锛/g,
  /銆/g,
  /鈥/g,
  /€/g,
];

function stripTerminalControls(value = "") {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function corruptionScore(value = "") {
  const text = String(value);
  let score = (text.match(/�/g) || []).length * 12;
  for (const marker of MOJIBAKE_MARKERS) score += (text.match(marker) || []).length * 3;
  score += (text.match(/[\u0080-\u009f]/g) || []).length * 4;
  return score;
}

function repairMojibake(value = "") {
  const source = stripTerminalControls(value);
  const sourceScore = corruptionScore(source);
  if (sourceScore < 3 || source.includes("�")) return source;
  try {
    const repaired = iconv.decode(iconv.encode(source, "gb18030"), "utf8");
    return corruptionScore(repaired) < sourceScore && !repaired.includes("�") ? repaired : source;
  } catch {
    return source;
  }
}

function hasIrrecoverableText(value = "") {
  return stripTerminalControls(value).includes("�");
}

function safeDisplayText(value = "", fallback = "") {
  const repaired = repairMojibake(value);
  return hasIrrecoverableText(repaired) ? fallback : repaired;
}

module.exports = {
  corruptionScore,
  hasIrrecoverableText,
  repairMojibake,
  safeDisplayText,
  stripTerminalControls,
};
