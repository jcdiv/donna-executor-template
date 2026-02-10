#!/usr/bin/env python3
"""
Import MCP server tools into Donna Executor registry.

Discovers tools from MCP servers, maps known services to API registry entries,
and pushes them to your deployed executor's /registry/import endpoint.

Usage:
  python scripts/import-mcp.py --url https://your-worker.workers.dev --token YOUR_ADMIN_TOKEN
  python scripts/import-mcp.py --url https://your-worker.workers.dev --token YOUR_TOKEN --server github
  python scripts/import-mcp.py --url https://your-worker.workers.dev --token YOUR_TOKEN --dry-run
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

# Default MCP config location (Claude Desktop)
DEFAULT_MCP_CONFIG = os.path.expanduser(
    "~/Library/Application Support/Claude/claude_desktop_config.json"
    if sys.platform == "darwin"
    else "~/.config/Claude/claude_desktop_config.json"
)

# Known API mappings for common MCP servers
KNOWN_SERVER_CONFIGS = {
    "github": {
        "base_url": "https://api.github.com",
        "auth_scheme": "bearer",
        "auth_env": "GITHUB_PERSONAL_ACCESS_TOKEN",
        "tools": {
            "create_issue": {"method": "POST", "path": "/repos/{owner}/{repo}/issues"},
            "get_issue": {"method": "GET", "path": "/repos/{owner}/{repo}/issues/{issue_number}"},
            "list_issues": {"method": "GET", "path": "/repos/{owner}/{repo}/issues"},
            "add_issue_comment": {"method": "POST", "path": "/repos/{owner}/{repo}/issues/{issue_number}/comments"},
            "create_pull_request": {"method": "POST", "path": "/repos/{owner}/{repo}/pulls"},
            "get_pull_request": {"method": "GET", "path": "/repos/{owner}/{repo}/pulls/{pull_number}"},
            "list_pull_requests": {"method": "GET", "path": "/repos/{owner}/{repo}/pulls"},
            "search_repositories": {"method": "GET", "path": "/search/repositories"},
            "search_code": {"method": "GET", "path": "/search/code"},
            "search_issues": {"method": "GET", "path": "/search/issues"},
            "get_file_contents": {"method": "GET", "path": "/repos/{owner}/{repo}/contents/{path}"},
            "list_commits": {"method": "GET", "path": "/repos/{owner}/{repo}/commits"},
            "create_repository": {"method": "POST", "path": "/user/repos"},
        }
    },
    "slack": {
        "base_url": "https://slack.com",
        "auth_scheme": "bearer",
        "auth_env": "SLACK_BOT_TOKEN",
        "tools": {
            "chat_postMessage": {"method": "POST", "path": "/api/chat.postMessage"},
            "chat_update": {"method": "POST", "path": "/api/chat.update"},
            "channels_list": {"method": "GET", "path": "/api/conversations.list"},
            "channels_history": {"method": "GET", "path": "/api/conversations.history"},
            "users_list": {"method": "GET", "path": "/api/users.list"},
        }
    },
    "hubspot": {
        "base_url": "https://api.hubapi.com",
        "auth_scheme": "bearer",
        "auth_env": "HUBSPOT_API_KEY",
        "tools": {
            "hubspot_list_objects": {"method": "GET", "path": "/crm/v3/objects/{objectType}"},
            "hubspot_search_objects": {"method": "POST", "path": "/crm/v3/objects/{objectType}/search"},
            "hubspot_list_properties": {"method": "GET", "path": "/crm/v3/properties/{objectType}"},
        }
    }
}


class MCPClient:
    """Client for communicating with MCP servers via JSON-RPC over stdio."""

    def __init__(self, server_name, command, args, env=None):
        self.server_name = server_name
        self.command = command
        self.args = args
        self.env = env or {}
        self.process = None
        self.request_id = 0

    def start(self):
        full_env = os.environ.copy()
        full_env.update(self.env)
        cmd = [self.command] + self.args
        self.process = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=full_env
        )

    def stop(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

    def send_request(self, method, params=None):
        self.request_id += 1
        request = {"jsonrpc": "2.0", "id": self.request_id, "method": method}
        if params:
            request["params"] = params
        request_str = json.dumps(request) + "\n"
        self.process.stdin.write(request_str.encode())
        self.process.stdin.flush()
        response_line = self.process.stdout.readline()
        if not response_line:
            return None
        return json.loads(response_line)

    def initialize(self):
        return self.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "donna-executor-importer", "version": "1.0"}
        })

    def list_tools(self):
        response = self.send_request("tools/list", {})
        if response and "result" in response:
            return response["result"].get("tools", [])
        return []


def generate_registry_entry(server_name, tool):
    """Convert an MCP tool to a registry entry."""
    tool_name = tool.get("name", "unknown").replace("-", "_")
    description = tool.get("description", "")
    input_schema = tool.get("inputSchema", {})
    properties = input_schema.get("properties", {})
    required = input_schema.get("required", [])

    server_config = KNOWN_SERVER_CONFIGS.get(server_name, {})
    tool_config = server_config.get("tools", {}).get(tool_name)

    op_key = f"{server_name.replace('-', '_')}.{tool_name}"

    if tool_config:
        # Known API mapping
        path_params = []
        import re
        for match in re.finditer(r'\{([^}]+)\}', tool_config.get("path", "")):
            path_params.append(match.group(1))

        # Required params = schema required minus path params
        req_params = [p for p in required if p not in path_params]

        return {
            "op_key": op_key,
            "service": server_name.replace("-", "_"),
            "method": tool_config["method"],
            "path": tool_config["path"],
            "base_url": server_config["base_url"],
            "auth_scheme": server_config["auth_scheme"],
            "auth_env": server_config["auth_env"],
            "required_params": req_params + path_params,
            "optional_params": [p for p in properties.keys() if p not in required and p not in path_params],
            "description": description,
            "status": "active"
        }
    else:
        # Unknown tool — create generic entry (user fills in details)
        return {
            "op_key": op_key,
            "service": server_name.replace("-", "_"),
            "method": "POST",
            "path": f"/{tool_name}",
            "base_url": "",
            "auth_scheme": "bearer",
            "auth_env": f"{server_name.upper().replace('-', '_')}_TOKEN",
            "required_params": required,
            "optional_params": [p for p in properties.keys() if p not in required],
            "description": description,
            "status": "draft"
        }


def push_to_worker(url, token, entries, dry_run=False):
    """Push registry entries to the worker's /registry/import endpoint."""
    if dry_run:
        print(f"\n[DRY RUN] Would push {len(entries)} entries to {url}/registry/import")
        for entry in entries[:5]:
            print(f"  {entry['op_key']} ({entry['method']} {entry.get('base_url', '?')}{entry['path']})")
        if len(entries) > 5:
            print(f"  ... and {len(entries) - 5} more")
        return

    data = json.dumps({"entries": entries}).encode()
    req = urllib.request.Request(
        f"{url.rstrip('/')}/registry/import",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            print(f"\nPushed to worker: {result.get('imported', 0)} entries imported")
    except urllib.error.HTTPError as e:
        print(f"\nError pushing to worker: {e.code} {e.read().decode()}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Import MCP tools into Donna Executor registry")
    parser.add_argument("--url", required=True, help="Worker URL (e.g., https://donna-executor.you.workers.dev)")
    parser.add_argument("--token", required=True, help="ADMIN_TOKEN for authentication")
    parser.add_argument("--config", default=DEFAULT_MCP_CONFIG, help="MCP config file path")
    parser.add_argument("--server", help="Import only this server")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be imported without pushing")
    args = parser.parse_args()

    if not os.path.exists(args.config):
        print(f"Error: MCP config not found at {args.config}")
        print("Specify path with --config or ensure Claude Desktop is installed")
        sys.exit(1)

    with open(args.config) as f:
        config = json.load(f)

    mcp_servers = config.get("mcpServers", {})
    if not mcp_servers:
        print("No MCP servers found in config")
        sys.exit(1)

    if args.server:
        if args.server not in mcp_servers:
            print(f'Error: Server "{args.server}" not found. Available: {", ".join(mcp_servers.keys())}')
            sys.exit(1)
        mcp_servers = {args.server: mcp_servers[args.server]}

    print("Discovering MCP servers...")
    print(f"Config: {args.config}\n")

    all_entries = []

    for server_name, server_config in mcp_servers.items():
        command = server_config.get("command")
        server_args = server_config.get("args", [])
        env = server_config.get("env", {})

        is_known = server_name in KNOWN_SERVER_CONFIGS
        marker = "[API]" if is_known else "[MCP]"
        print(f"  {server_name} {marker}... ", end="", flush=True)

        client = MCPClient(server_name, command, server_args, env)
        try:
            client.start()
            time.sleep(0.5)

            if client.process.poll() is not None:
                print("failed to start")
                continue

            init_response = client.initialize()
            if not init_response:
                print("no init response")
                client.stop()
                continue

            client.send_request("notifications/initialized", {})
            tools = client.list_tools()

            if not tools:
                print("0 tools")
            else:
                print(f"{len(tools)} tools")
                for tool in tools:
                    entry = generate_registry_entry(server_name, tool)
                    all_entries.append(entry)

            client.stop()
        except Exception as e:
            print(f"error: {str(e)[:50]}")
            try:
                client.stop()
            except:
                pass

    if not all_entries:
        print("\nNo tools discovered.")
        sys.exit(1)

    active = [e for e in all_entries if e["status"] == "active"]
    draft = [e for e in all_entries if e["status"] == "draft"]

    print(f"\nDiscovered {len(all_entries)} total entries:")
    print(f"  {len(active)} API-backed (ready to use)")
    print(f"  {len(draft)} unknown (need base_url configuration)")

    if active:
        print(f"\nAPI-backed entries:")
        for entry in active[:10]:
            print(f"  {entry['op_key']:<40} {entry['method']} {entry.get('base_url', '')}{entry['path']}")
        if len(active) > 10:
            print(f"  ... and {len(active) - 10} more")

    # Only push active entries
    push_to_worker(args.url, args.token, active, args.dry_run)

    if draft:
        print(f"\nDraft entries (configure base_url and push manually):")
        draft_path = "examples/draft-registry-entries.json"
        if not args.dry_run:
            with open(draft_path, "w") as f:
                json.dump(draft, f, indent=2)
            print(f"  Written to {draft_path}")


if __name__ == "__main__":
    main()
