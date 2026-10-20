from openai import OpenAI

client = OpenAI(
    base_url="http://10.1.15.229:8111/v1",
    api_key="EMPTY",
    timeout=120.0,
)

response = client.chat.completions.create(
    model="Qwen3.8-27B-FP8",
    messages=[
        {"role": "system", "content": "你是一个专业的AI助手，请使用中文回答。"},
        {"role": "user", "content": "你好，请介绍一下你自己。"},
    ],
    temperature=0.7,
    max_tokens=512,
)

print(response.choices[0].message.content)