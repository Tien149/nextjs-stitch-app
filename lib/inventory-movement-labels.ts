/** Tên tiếng Việt của loại phiếu kho — dùng chung màn Kho và trang in phiếu nhập/xuất. */
export function movementTypeLabel(type: string): string {
  const map: Record<string, string> = {
    NHAP_MUA: "Nhập mua",
    NHAP_KHAC: "Nhập khác",
    NHAP_CHE_BIEN: "Nhập chế biến",
    NHAP_KIEM_KE: "Nhập điều chỉnh kiểm kê",
    NHAP_DIEU_CHUYEN: "Nhập điều chuyển",
    XUAT_BAN: "Xuất bán",
    XUAT_HUY: "Xuất hủy",
    XUAT_TEST_MON: "Xuất test món",
    XUAT_KHAC: "Xuất khác",
    XUAT_CHE_BIEN: "Xuất chế biến",
    XUAT_KIEM_KE: "Xuất điều chỉnh kiểm kê",
    XUAT_DIEU_CHUYEN: "Xuất điều chuyển",
    DIEU_CHUYEN: "Điều chuyển kho",
  };
  return map[type] || type;
}
