from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"


def build_base() -> Image.Image:
    image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.polygon([(4, 1), (28, 1), (31, 4), (31, 28), (28, 31), (4, 31), (1, 28), (1, 4)], fill="#050812")
    draw.rectangle((4, 1, 16, 1), fill="#00e5ff")
    draw.rectangle((1, 4, 1, 14), fill="#00e5ff")
    draw.rectangle((16, 30, 28, 30), fill="#00e5ff")
    draw.rectangle((30, 18, 30, 28), fill="#00e5ff")
    draw.rectangle((20, 1, 28, 1), fill="#ff2bd6")
    draw.rectangle((1, 22, 1, 28), fill="#ff2bd6")

    draw.rectangle((15, 3, 16, 6), fill="#7ecada")
    draw.rectangle((14, 2, 17, 3), fill="#00e5ff")
    draw.polygon([(8, 6), (24, 6), (26, 8), (26, 16), (24, 18), (8, 18), (6, 16), (6, 8)], fill="#dffcff")
    draw.rectangle((8, 16, 24, 18), fill="#76b8c8")
    draw.rectangle((9, 9, 23, 15), fill="#070a12")
    draw.rectangle((11, 11, 13, 12), fill="#00e5ff")
    draw.rectangle((18, 11, 20, 12), fill="#00e5ff")
    draw.rectangle((22, 15, 23, 16), fill="#ff2bd6")

    draw.rectangle((12, 18, 20, 25), fill="#9adbe6")
    draw.rectangle((12, 23, 20, 25), fill="#3c8194")
    draw.rectangle((15, 20, 16, 21), fill="#ff2bd6")
    draw.rectangle((8, 19, 10, 26), fill="#76c6d8")
    draw.rectangle((21, 19, 23, 26), fill="#76c6d8")
    draw.rectangle((7, 25, 11, 28), fill="#dffcff")
    draw.rectangle((20, 25, 24, 28), fill="#dffcff")
    draw.rectangle((12, 25, 14, 29), fill="#6db7c8")
    draw.rectangle((17, 25, 19, 29), fill="#6db7c8")
    draw.rectangle((10, 28, 14, 30), fill="#dffcff")
    draw.rectangle((17, 28, 21, 30), fill="#dffcff")
    return image


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    icon = build_base().resize((256, 256), Image.Resampling.NEAREST)
    icon.save(ASSETS / "lumo.png", optimize=True)
    icon.save(
        ASSETS / "lumo.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
