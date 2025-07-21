#!/usr/bin/env python3
import os
import json

# Adjust this if your data folder lives somewhere else
DATA_ROOT = "Modern-Industrialization-2.3.9/data"

def main():
    tags = []
    recipes = []

    for dirpath, _, filenames in os.walk(DATA_ROOT):
        for fn in filenames:
            if not fn.endswith(".json"):
                continue
            full_path = os.path.join(dirpath, fn).replace("\\", "/")
            # classify as tag or recipe by folder name
            if "/tags/items/" in full_path or "/tags/item/" in full_path:
                tags.append(full_path)
            if "/recipe/" in full_path or "/recipes/" in full_path:
                recipes.append(full_path)

    manifest = {
        "tags": sorted(tags),
        "recipes": sorted(recipes)
    }
    with open("manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"➜  Wrote manifest.json with {len(tags)} tags and {len(recipes)} recipes")

if __name__ == "__main__":
    main()
