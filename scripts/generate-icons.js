const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const sizes = [16, 48, 128];
const svgPath = path.join(__dirname, "../icons/icon.svg");
const iconsDir = path.join(__dirname, "../icons");

async function generateIcons() {
  console.log("🎨 アイコン生成を開始します...\n");

  if (!fs.existsSync(svgPath)) {
    console.error("❌ エラー: icon.svg が見つかりません");
    process.exit(1);
  }

  fs.mkdirSync(iconsDir, { recursive: true });

  // 各サイズの PNG を並列生成。個別失敗は reject させて exit 1 にする
  // (壊れたアイコンでの ZIP 生成を防ぐ)。
  await Promise.all(
    sizes.map(async (size) => {
      const outputPath = path.join(iconsDir, `icon-${size}.png`);
      try {
        await sharp(svgPath).resize(size, size).png().toFile(outputPath);
        console.log(`✅ ${size}x${size} アイコンを生成しました: ${path.basename(outputPath)}`);
      } catch (error) {
        console.error(`❌ ${size}x${size} アイコンの生成に失敗しました:`, error.message);
        throw error;
      }
    })
  );

  console.log("\n🎉 アイコン生成が完了しました！");
}

generateIcons().catch((error) => {
  console.error("❌ エラーが発生しました:", error);
  process.exit(1);
});
