import asyncio
import httpx
import json
import sqlite3

async def main():
    conn = sqlite3.connect('/home/starlee/dev/LLM_Server_Router/llm_router.db')
    cur = conn.cursor()
    cur.execute("SELECT api_key FROM provider_endpoints WHERE id = 3")
    row = cur.fetchone()
    conn.close()
    
    if not row:
        print("No provider")
        return
        
    token_data = json.loads(row[0])
    access_token = token_data.get("access_token")
    project_id = token_data.get("project_id")
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
    }
    
    body = {
        "model": "gemini-3-flash-preview",
        "request": {
            "contents": [{"role": "user", "parts": [{"text": "Write a haiku about cats"}]}]
        },
        "project": project_id
    }
    
    async with httpx.AsyncClient() as client:
        # Try streamGenerateContent
        resp = await client.post(
            "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
            headers=headers,
            json=body,
            timeout=30.0
        )
        print("Status:", resp.status_code)
        print("Headers:", resp.headers)
        print("Body:", resp.text[:500])

asyncio.run(main())
