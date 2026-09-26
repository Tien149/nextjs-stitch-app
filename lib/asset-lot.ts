/**
 * Tài sản/CCDC NHIỀU ĐỢT dưới một mã (khách chốt 26/09/2026).
 *
 * Mua tăng cùng loại ở thời điểm khác, hay số dư đầu kỳ khai hai đợt cùng mã khác thời gian phân
 * bổ, đều dùng lại mã cũ: mỗi đợt là một dòng `AssetRecord` riêng (cùng `code`, `lotNo` tăng dần)
 * để khấu hao/phân bổ, bảo trì, thanh lý chạy theo đúng ngày mua và số kỳ của đợt đó. Cặp
 * (code, lotNo) là duy nhất; công nợ/bút toán của đợt ≥ 2 mang hậu tố `-L<đợt>`.
 */

export type AssetLotRef = { code: string; lotNo?: number | null };

/** "CCDCKIT0003" cho đợt 1, "CCDCKIT0003 · đợt 2" cho các đợt sau. */
export function assetLotLabel(asset: AssetLotRef) {
  const lot = asset.lotNo || 1;
  return lot > 1 ? `${asset.code} · đợt ${lot}` : asset.code;
}

/** Mã công nợ / bút toán của một đợt: đợt 1 giữ nguyên dạng cũ để dữ liệu đã có không đổi. */
export function assetLotCodeSuffix(asset: AssetLotRef) {
  const lot = asset.lotNo || 1;
  return lot > 1 ? `-L${lot}` : "";
}

export function assetPayableCode(asset: AssetLotRef) {
  return `CN-${asset.code}${assetLotCodeSuffix(asset)}`;
}

export function assetAcquisitionJournalCode(asset: AssetLotRef) {
  return `JE-ASSET-${asset.code}${assetLotCodeSuffix(asset)}`;
}

export type StocktakeLotInput = { id: string; lotNo: number; quantity: number };
export type StocktakeLotResult = { id: string; lotNo: number; systemQuantity: number; actualQuantity: number };

/**
 * Chia SỐ ĐẾM THEO MÃ về từng đợt. Nhân viên kiểm kê đếm cái nồi, không phân biệt nồi mua đợt
 * nào, nên phiên kiểm kê nhận một số đếm cho cả mã; hệ thống tự phân bổ:
 * - Thừa so với sổ: đợt cũ giữ nguyên, phần thừa ghi vào ĐỢT MỚI NHẤT.
 * - Thiếu so với sổ: trừ dần từ đợt mới nhất về đợt cũ (hàng mua sau coi như bị hụt trước).
 * Cách này giữ nguyên số của các đợt đã phân bổ lâu, chỉ động vào đợt gần nhất.
 */
export function distributeStocktakeCount(lots: StocktakeLotInput[], actualTotal: number): StocktakeLotResult[] {
  const ordered = [...lots].sort((a, b) => a.lotNo - b.lotNo);
  const systemTotal = ordered.reduce((sum, lot) => sum + (lot.quantity || 0), 0);
  const actual = Math.max(0, actualTotal);
  const result = ordered.map((lot) => ({ id: lot.id, lotNo: lot.lotNo, systemQuantity: lot.quantity || 0, actualQuantity: lot.quantity || 0 }));
  if (result.length === 0) return result;
  if (actual >= systemTotal) {
    result[result.length - 1].actualQuantity += actual - systemTotal;
    return result;
  }
  let deficit = systemTotal - actual;
  for (let index = result.length - 1; index >= 0 && deficit > 0; index -= 1) {
    const reduce = Math.min(result[index].actualQuantity, deficit);
    result[index].actualQuantity -= reduce;
    deficit -= reduce;
  }
  return result;
}

/** Gom các đợt của cùng một mã, giữ thứ tự xuất hiện của mã. */
export function groupAssetLots<T extends AssetLotRef>(assets: T[]): Array<{ code: string; lots: T[] }> {
  const map = new Map<string, T[]>();
  for (const asset of assets) {
    const bucket = map.get(asset.code) || [];
    bucket.push(asset);
    map.set(asset.code, bucket);
  }
  return [...map.entries()].map(([code, lots]) => ({ code, lots: [...lots].sort((a, b) => (a.lotNo || 1) - (b.lotNo || 1)) }));
}
