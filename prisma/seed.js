const { PrismaClient } = require('@prisma/custom-client');
const prisma = new PrismaClient();

async function main() {
  // Clear existing document
  await prisma.document.deleteMany({});
  
  // Clear User related
  await prisma.userBranchAccess.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.role.deleteMany({});

  const rolesData = [
    { name: 'Admin', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'config'] },
    { name: 'Kế toán tổng hợp', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
    { name: 'Kế toán công nợ', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
    { name: 'Quản lý', actions: ['view', 'approve', 'export'] },
    { name: 'Viewer', actions: ['view'] }
  ];

  const roles = {};
  for (const role of rolesData) {
    const createdRole = await prisma.role.create({
      data: role
    });
    roles[role.name] = createdRole.id;
  }

  const usersData = [
    {
      id: 'admin',
      email: 'admin@fin-erp.vn',
      password: '123456',
      name: 'Admin Kế toán',
      roleName: 'Admin',
      branch: 'Admin / Tất cả cửa hàng',
      branches: ['ALL']
    },
    {
      id: 'ktth',
      email: 'ktth@fin-erp.vn',
      password: '123456',
      name: 'Kế toán tổng hợp',
      roleName: 'Kế toán tổng hợp',
      branch: 'Admin / Tất cả cửa hàng',
      branches: ['ALL']
    },
    {
      id: 'congno',
      email: 'congno@fin-erp.vn',
      password: '123456',
      name: 'Kế toán công nợ',
      roleName: 'Kế toán công nợ',
      branch: 'Chủ cửa hàng - Cửa hàng 1',
      branches: ['HCM']
    },
    {
      id: 'quanly',
      email: 'quanly@fin-erp.vn',
      password: '123456',
      name: 'Chủ cửa hàng',
      roleName: 'Quản lý',
      branch: 'Chủ cửa hàng - Cửa hàng 2',
      branches: ['HN']
    },
    {
      id: 'viewer',
      email: 'viewer@fin-erp.vn',
      password: '123456',
      name: 'Viewer',
      roleName: 'Viewer',
      branch: 'Admin / Tất cả cửa hàng',
      branches: ['ALL']
    }
  ];

  for (const userData of usersData) {
    await prisma.user.create({
      data: {
        id: userData.id,
        email: userData.email,
        password: userData.password,
        name: userData.name,
        roleId: roles[userData.roleName],
        branchAccesses: {
          create: userData.branches.map(b => ({ branchCode: b }))
        }
      }
    });
  }

  const docs = [
    {
      code: 'PC-2024-00124',
      partner: 'Công ty TNHH Giải pháp số X',
      description: 'Thanh toán phí duy trì Server Q2/2024',
      amount: 125400000,
      status: 'PENDING',
    },
    {
      code: 'PT-2024-05891',
      partner: 'Tập đoàn Bất động sản Blue',
      description: 'Thu tiền đặt cọc dự án Sky Tower A',
      amount: 2500000000,
      status: 'COMPLETED',
    },
    {
      code: 'PC-2024-00125',
      partner: 'Cửa hàng Vật liệu Xây dựng S',
      description: 'Mua vật tư bảo trì máy móc phân xưởng 3',
      amount: 45200000,
      status: 'DRAFT',
    }
  ];

  for (const doc of docs) {
    await prisma.document.create({
      data: doc
    });
  }

  console.log('Database seeded successfully with Roles and Users!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
