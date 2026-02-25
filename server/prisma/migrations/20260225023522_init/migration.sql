-- AlterTable
ALTER TABLE "Profile" ALTER COLUMN "headline" DROP DEFAULT,
ALTER COLUMN "summary" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Resume" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ResumeVersion" ALTER COLUMN "updatedAt" DROP DEFAULT;
