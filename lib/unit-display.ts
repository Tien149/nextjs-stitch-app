/**
 * Tên ĐVT để in lên phiếu gửi NCC (khách 25/10/2026: "ĐVT lấy tên, không lấy mã").
 *
 * Danh mục chỉ lưu MÃ ĐVT viết liền không dấu (CAI, O, GOI500GR, THUNG24LON330ML) và gần như
 * không có tên riêng, nên tách mã thành từ đã biết + số: GOI500GR → "Gói 500gr",
 * THUNG24LON330ML → "Thùng 24 lon 330ml". Mã có chữ lạ (CHAIGIFFARD700ML) giữ nguyên.
 */

const WORDS: Record<string, string> = {
  AM: "ấm", BAO: "bao", BICH: "bịch", BINH: "bình", BO: "bó", CAI: "cái", CAN: "can", CAY: "cây",
  CHAI: "chai", CHEN: "chén", COMBO: "combo", CON: "con", CUC: "cục", CUON: "cuộn", DIA: "đĩa",
  DICHVU: "dịch vụ", DOI: "đôi", GOI: "gói", HOP: "hộp", HU: "hũ", KHOI: "khối", LA: "lá", LAN: "lần",
  LO: "lọ", LOC: "lốc", LON: "lon", LUOT: "lượt", LY: "ly", MIENG: "miếng", MON: "món", "MÓN": "món",
  O: "ổ", ONG: "ống", PHAN: "phần", "PHẦN": "phần", QUE: "que", QUYEN: "quyển", RAM: "ram", SET: "set",
  SHOT: "shot", SIZE: "size", THUNG: "thùng", TO: "tờ", TRAI: "trái", TUI: "túi", TUYP: "tuýp", VAT: "vắt", VIEN: "viên",
  XAP: "xấp", XIEN: "xiên",
};

/** Đơn vị đo viết liền sau số: 500gr, 330ml, 2kg. */
const MEASURES: Record<string, string> = { GR: "gr", GRAM: "gram", ML: "ml", KG: "kg" };
/** Lít viết cách: 3 lít. */
const LITRES = new Set(["L", "LIT", "LÍT"]);

type Token = { kind: "word" | "measure" | "litre"; text: string } | { kind: "number"; text: string };

const VOCABULARY = [...Object.keys(WORDS), ...Object.keys(MEASURES), ...LITRES].sort((a, b) => b.length - a.length);

function tokenize(code: string, from: number, memo: Map<number, Token[] | null>): Token[] | null {
  if (from === code.length) return [];
  if (memo.has(from)) return memo.get(from)!;
  let result: Token[] | null = null;
  const number = /^\d+(?:[.,-]\d+)?/.exec(code.slice(from))?.[0];
  if (number) {
    const rest = tokenize(code, from + number.length, memo);
    if (rest) result = [{ kind: "number", text: number }, ...rest];
  } else {
    for (const word of VOCABULARY) {
      if (!code.startsWith(word, from)) continue;
      const rest = tokenize(code, from + word.length, memo);
      if (!rest) continue;
      const token: Token = MEASURES[word] ? { kind: "measure", text: MEASURES[word] }
        : LITRES.has(word) ? { kind: "litre", text: "lít" }
        : { kind: "word", text: WORDS[word] };
      result = [token, ...rest];
      break;
    }
  }
  memo.set(from, result);
  return result;
}

/** Mã ĐVT → tên đọc được; `unitName` khai riêng (khác mã) thì dùng luôn. */
export function unitDisplayName(unitCode: string | null | undefined, unitName?: string | null) {
  const code = (unitCode || "").trim();
  if (unitName && unitName.trim() && unitName.trim().toUpperCase() !== code.toUpperCase()) return unitName.trim();
  if (!code) return "";
  const normalized = code.toUpperCase().replace(/[^\p{L}\p{N}.,-]+/gu, "").replace(/[.,]+$/, "");
  const tokens = tokenize(normalized, 0, new Map());
  if (!tokens || tokens.length === 0) return code;
  let text = "";
  tokens.forEach((token, index) => {
    const glued = token.kind === "measure" && tokens[index - 1]?.kind === "number";
    text += index === 0 || glued ? token.text : ` ${token.text}`;
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
}
