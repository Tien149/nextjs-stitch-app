import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
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
    const body = await request.json();
    const { partner, description, amount, status } = body;

    if (!partner || !description || amount === undefined || !status) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Generate a code (PC-YYYY-XXXXX or PT-YYYY-XXXXX) based on amount or custom rule
    const isPayment = status === 'PENDING' || status === 'DRAFT';
    const prefix = isPayment ? 'PC' : 'PT';
    const year = new Date().getFullYear();
    const count = await prisma.document.count();
    const code = `${prefix}-${year}-${String(count + 125).padStart(5, '0')}`;

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
