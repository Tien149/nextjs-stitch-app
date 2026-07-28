"use client";

import { ModuleFrame } from "@/components/ModuleFrame";
import { TrashPanel } from "@/components/TrashPanel";
import { useModuleAuth } from "@/lib/use-module-auth";

export default function TrashPage() {
  const { user, loading } = useModuleAuth("/trash");

  if (loading || !user) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <ModuleFrame
      title="Thùng rác"
      subtitle="Xem lại và khôi phục dữ liệu đã xoá trên toàn hệ thống"
      role={user.role}
    >
      <TrashPanel session={user} />
    </ModuleFrame>
  );
}
