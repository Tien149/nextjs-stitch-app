const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Clear existing
  await prisma.document.deleteMany({});

  const docs = [
    {
      code: 'PC-2024-00124',
      partner: 'Công ty TNHH Giải pháp số X',
      description: 'Thanh toán phí duy trì Server Q2/2024',
      amount: 125400000,
      status: 'PENDING', // Đang chờ Duyệt
    },
    {
      code: 'PT-2024-05891',
      partner: 'Tập đoàn Bất động sản Blue',
      description: 'Thu tiền đặt cọc dự án Sky Tower A',
      amount: 2500000000,
      status: 'COMPLETED', // Hoàn tất
    },
    {
      code: 'PC-2024-00125',
      partner: 'Cửa hàng Vật liệu Xây dựng S',
      description: 'Mua vật tư bảo trì máy móc phân xưởng 3',
      amount: 45200000,
      status: 'DRAFT', // Lưu nháp
    }
  ];

  for (const doc of docs) {
    await prisma.document.create({
      data: doc
    });
  }

  console.log('Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
