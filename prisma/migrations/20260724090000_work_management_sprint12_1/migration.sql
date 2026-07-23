CREATE TABLE "WorkChecklistItem" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkComment" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkAttachment" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "url" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkChecklistItem_workItemId_position_idx" ON "WorkChecklistItem"("workItemId", "position");
CREATE INDEX "WorkChecklistItem_isDone_idx" ON "WorkChecklistItem"("isDone");
CREATE INDEX "WorkComment_workItemId_createdAt_idx" ON "WorkComment"("workItemId", "createdAt");
CREATE INDEX "WorkAttachment_workItemId_createdAt_idx" ON "WorkAttachment"("workItemId", "createdAt");

ALTER TABLE "WorkChecklistItem"
ADD CONSTRAINT "WorkChecklistItem_workItemId_fkey"
FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkComment"
ADD CONSTRAINT "WorkComment_workItemId_fkey"
FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkAttachment"
ADD CONSTRAINT "WorkAttachment_workItemId_fkey"
FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "WorkChecklistItem" (
    "id",
    "workItemId",
    "title",
    "position",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    work_item."id",
    legacy_item."title",
    legacy_item."position" - 1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "WorkItem" AS work_item
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
        WHEN work_item."checklistJson" IS NULL OR work_item."checklistJson" = '' THEN '[]'::jsonb
        ELSE work_item."checklistJson"::jsonb
    END
) WITH ORDINALITY AS legacy_item("title", "position");
