import { roundVnd } from "@/lib/round-vnd";

/**
 * Thuế suất thuế GTGT ĐẦU VÀO trên từng dòng phiếu nhập mua.
 *
 * Khách chốt 21/09/2026: giá vốn tồn kho lấy số TRƯỚC thuế, công nợ phải trả NCC lấy số SAU
 * thuế — cách hạch toán của công ty kê khai khấu trừ. Nên mỗi dòng giữ hai số tách bạch:
 * `totalCost` (trước thuế, đi vào tồn kho & giá bình quân) và `vatAmount` (phần thuế, chỉ
 * cộng vào khoản phải trả). Không gộp thuế vào `unitCost`: gộp là đơn giá bình quân của kho
 * bị đội lên đúng phần thuế và mọi phiếu xuất sau đó mang giá vốn sai.
 *
 * KKKNT = "không kê khai, nộp thuế" — khác 0%: cùng ra 0 đồng tiền thuế nhưng là hai dòng
 * khác nhau trên tờ khai, nên lưu `null` cho KKKNT và `0` cho 0% để sau này lên tờ khai còn
 * tách được.
 *
 * Ô ĐỂ TRỐNG cũng là `null`, tức là cùng nghĩa với KKKNT — không khai gì thì cũng không có
 * đồng thuế nào phải nộp. Gộp hai thứ làm một là có chủ đích: tách ra thì phải thêm một cột
 * nữa chỉ để phân biệt hai trạng thái luôn cho cùng một con số, mà mở lại phiếu là ô chọn
 * không biết hiện cái nào. Danh sách lựa chọn vì vậy đúng 5 mã khách liệt kê, không có mục
 * "để trống" riêng.
 */
export type VatRateOption = {
  /** Mã người dùng gõ trong file / chọn trên màn hình. */
  code: string;
  /** Câu giải thích cho sheet "Thue suat GTGT" của file mẫu và tooltip trên màn hình. */
  description: string;
  /** Thuế suất dạng số để nhân; null = KKKNT (không có thuế). */
  rate: number | null;
};

export const VAT_RATE_OPTIONS: VatRateOption[] = [
  { code: "KKKNT", description: "Không kê khai, nộp thuế", rate: null },
  { code: "0%", description: "Thuế suất 0%", rate: 0 },
  { code: "5%", description: "Thuế suất 5%", rate: 0.05 },
  { code: "8%", description: "Thuế suất 8%", rate: 0.08 },
  { code: "10%", description: "Thuế suất 10%", rate: 0.1 },
];

/** Danh sách mã in ra file mẫu và câu báo lỗi — giữ đúng thứ tự khách liệt kê. */
export const VAT_RATE_CODES = VAT_RATE_OPTIONS.map((option) => option.code);

/**
 * Đọc ô "Thuế suất thuế GTGT" của file import hoặc của form.
 *
 * Nhận rộng vì mỗi nơi gõ một kiểu: "10%", "10", 0.1 (Excel định dạng ô là phần trăm thì giá
 * trị thật xuống còn 0.1), "KKKNT", "kkknt". Trả `undefined` khi không hiểu được để nơi gọi
 * báo lỗi ngay tại preview thay vì lặng lẽ nhận nhầm thành 0%.
 */
export function parseVatRate(value: unknown): { ok: true; rate: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, rate: null };
  const raw = String(value).trim();
  if (!raw) return { ok: true, rate: null };

  const normalized = raw.toUpperCase().replace(/\s+/g, "");
  if (normalized === "KKKNT" || normalized === "KHONGKEKHAI") return { ok: true, rate: null };

  // "10%" -> 10, "10" -> 10, "0,1" -> 0.1 (dấu phẩy thập phân kiểu Việt).
  const hasPercentSign = normalized.endsWith("%");
  const numeric = Number(normalized.replace("%", "").replace(",", "."));
  if (!Number.isFinite(numeric)) return { ok: false };

  // Excel để ô dạng phần trăm thì 10% xuống tới đây là 0.1 — không có dấu % và <= 1 nghĩa là
  // đã ở dạng thập phân. Riêng số 1 trần là 1% chứ không phải 100%: không có thuế suất 100%.
  const percent = hasPercentSign || numeric > 1 ? numeric : numeric * 100;
  const option = VAT_RATE_OPTIONS.find((item) => item.rate !== null && Math.abs(item.rate * 100 - percent) < 0.0001);
  return option ? { ok: true, rate: option.rate } : { ok: false };
}

/**
 * Nhãn hiển thị của thuế suất đã lưu, và cũng là mã để ô chọn trên màn hình khớp lại đúng
 * dòng đã lưu. `null` ra "KKKNT" — chỉ gọi cho dòng phiếu NHẬP; dòng xuất/điều chuyển không
 * có thuế đầu vào nên cũng mang `null`, nhưng ở đó không bao giờ in nhãn này ra.
 */
export function vatRateLabel(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return "KKKNT";
  return `${Number((rate * 100).toFixed(2))}%`;
}

/**
 * Tiền thuế của một dòng, LÀM TRÒN TỚI ĐỒNG.
 *
 * Tròn ngay ở đây chứ không để cộng dồn rồi mới tròn: khách chốt "Thành tiền round tới đvt
 * đồng", và số trên từng dòng phải cộng lại đúng bằng tổng phiếu — tròn ở tổng thì từng dòng
 * in ra lẻ, kế toán cộng tay lại ra số khác.
 */
export function vatAmountOf(amountBeforeTax: number, rate: number | null | undefined) {
  if (rate === null || rate === undefined || !rate) return 0;
  return roundVnd(amountBeforeTax * rate);
}

/** Thành tiền sau thuế của một dòng. */
export function amountAfterTax(amountBeforeTax: number, vatAmount: number) {
  return roundVnd(amountBeforeTax) + vatAmount;
}
