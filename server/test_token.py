"""测试 API token 可用模型列表 & 简单多模态调用"""

import os
import json
import urllib.request

BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.vectortara.com")
API_KEY = os.environ.get("OPENAI_API_KEY", "")

if not API_KEY:
    print("请设置环境变量 OPENAI_API_KEY")
    exit(1)

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}

# 1. 列出可用模型
print("=" * 60)
print("1. 查询可用模型列表")
print("=" * 60)
try:
    req = urllib.request.Request(f"{BASE_URL}/v1/models", headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
        models = [m["id"] for m in data.get("data", [])]
        print(f"共 {len(models)} 个模型:")
        for m in sorted(models):
            print(f"  - {m}")
except Exception as e:
    print(f"查询失败: {e}")
    models = []

# 2. 用 gpt-5.2 发一条简单请求
print()
print("=" * 60)
print("2. 测试 gpt-5.2 文本请求")
print("=" * 60)
try:
    body = json.dumps({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "你好，回复OK即可"}],
        "max_tokens": 10,
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/v1/chat/completions",
        data=body, headers=headers, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
        reply = result["choices"][0]["message"]["content"]
        print(f"回复: {reply}")
except Exception as e:
    print(f"失败: {e}")

# 3. 测试多模态 (image_url)
print()
print("=" * 60)
print("3. 测试 gpt-5.2 多模态 (image_url)")
print("=" * 60)
try:
    body = json.dumps({
        "model": "gpt-4o",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "这张图片是什么？简短回答"},
                {"type": "image_url", "image_url": {
                    "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png"
                }},
            ],
        }],
        "max_tokens": 50,
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/v1/chat/completions",
        data=body, headers=headers, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
        reply = result["choices"][0]["message"]["content"]
        print(f"回复: {reply}")
except Exception as e:
    print(f"失败: {e}")
