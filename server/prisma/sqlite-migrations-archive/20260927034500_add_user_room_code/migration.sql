-- AlterTable
ALTER TABLE "User" ADD COLUMN "roomCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_roomCode_key" ON "User"("roomCode");
