import { NextResponse } from 'next/server';
import { requireNamedMenuAccess, requireNamedMenuAction } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";

export async function GET(request: Request) {
  try {
    const auth = requireNamedMenuAccess(request, '/', 'Dashboard');
    if (!auth.ok) return auth.response;

    const documents = await prisma.document.findMany({
      orderBy: { date: 'desc' },
    });
    return NextResponse.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireNamedMenuAction(request, '/', 'Dashboard', 'create');
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { partner, description, amount, status } = body;

    if (!partner || !description || amount === undefined || !status) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Generate a code (PC-YYYY-XXXXX or PT-YYYY-XXXXX) based on amount or custom rule
    const isPayment = status === 'PENDING' || status === 'DRAFT';
    const prefix = isPayment ? 'PC' : 'PT';
    const year = new Date().getFullYear();
    // COUNT toàn bảng đếm lẫn cả PC và PT của mọi năm nên số thứ tự không thuộc chuỗi nào;
    // "+125" là bù trừ cho dữ liệu cũ. Max + 1 trong đúng chuỗi loại + năm giữ được số đang
    // chạy (mã cũ đã mang sẵn phần bù) mà không bao giờ cấp lại mã đang tồn tại.
    const documentPrefix = `${prefix}-${year}-`;
    const issuedDocumentCodes = await prisma.document.findMany({
      where: { code: { startsWith: documentPrefix } },
      select: { code: true },
    });
    const seq = nextSeqFromCodes(issuedDocumentCodes.map((row) => row.code), documentPrefix);
    const code = documentPrefix + String(Math.max(seq, 125)).padStart(5, '0');

    const newDoc = await prisma.document.create({
      data: {
        code,
        partner,
        description,
        amount: parseFloat(amount),
        status,
      },
    });

    return NextResponse.json(newDoc, { status: 201 });
  } catch (error) {
    console.error('Error creating document:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
