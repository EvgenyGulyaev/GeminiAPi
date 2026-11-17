from gemini_bridge.protocol import (
    FENCE,
    flatten_messages,
    holdback_end,
    parse_reply,
    tool_instructions,
)


def test_parse_single_call():
    text = f'Проверяю файлы.\n{FENCE}\n{{"name": "bash", "arguments": {{"command": "ls"}}}}\n```'
    p = parse_reply(text)
    assert p.text == "Проверяю файлы."
    assert len(p.calls) == 1
    assert p.calls[0].name == "bash"
    assert p.calls[0].arguments == {"command": "ls"}


def test_parse_multiple_calls_and_tail_text():
    text = (
        f'{FENCE}\n{{"name": "read", "arguments": {{"path": "a.py"}}}}\n```\n'
        f'{FENCE}\n{{"name": "read", "arguments": {{"path": "b.py"}}}}\n```\n'
        "Готово."
    )
    p = parse_reply(text)
    assert [c.name for c in p.calls] == ["read", "read"]
    assert p.text == "Готово."


def test_malformed_block_stays_in_text():
    text = f'{FENCE}\n{{"name": "bash", broken\n```'
    p = parse_reply(text)
    assert p.calls == []
    assert "broken" in p.text


def test_wrong_shape_stays_in_text():
    text = f'{FENCE}\n{{"name": 42, "arguments": {{}}}}\n```'
    p = parse_reply(text)
    assert p.calls == []
    assert "42" in p.text


def test_plain_code_fence_untouched():
    text = "```python\nprint('hi')\n```"
    p = parse_reply(text)
    assert p.calls == []
    assert p.text == text


def test_holdback_full_fence():
    text = f'до фенса {FENCE}\n{{"name"'
    assert holdback_end(text) == len("до фенса ")


def test_holdback_partial_fence():
    assert holdback_end("текст ``") == len("текст ")
    assert holdback_end("текст ```tool_") == len("текст ")
    assert holdback_end("обычный текст") == len("обычный текст")


def test_holdback_regular_fence_resolves():
    # '```python' is not a tool_call opener: only the bare backticks hold back
    assert holdback_end("```python\nx") == len("```python\nx")


def test_flatten_roles_and_tool_roundtrip():
    messages = [
        {"role": "system", "content": "Ты агент."},
        {"role": "user", "content": "прочитай a.py"},
        {
            "role": "assistant",
            "content": "читаю",
            "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "read", "arguments": '{"path": "a.py"}'}}
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "read", "content": "print(1)"},
    ]
    prompt = flatten_messages(messages)
    assert "# SYSTEM\nТы агент." in prompt
    assert "# USER\nпрочитай a.py" in prompt
    assert FENCE in prompt  # assistant tool_calls re-rendered as protocol blocks
    assert '"name": "read"' in prompt
    assert "[TOOL RESULT name=read call_id=call_1]\nprint(1)" in prompt
    # roundtrip: re-rendered assistant blocks parse back into calls
    assistant_part = prompt.split("# ASSISTANT\n")[1].split("[TOOL RESULT")[0]
    assert parse_reply(assistant_part).calls[0].arguments == {"path": "a.py"}


def test_flatten_multimodal_text_only():
    messages = [
        {"role": "user", "content": [
            {"type": "text", "text": "смотри"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
        ]}
    ]
    prompt = flatten_messages(messages)
    assert "смотри" in prompt
    assert "[image omitted" in prompt


def test_tool_instructions_contain_schema():
    tools = [{"type": "function", "function": {
        "name": "bash", "description": "run command",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}},
    }}]
    ins = tool_instructions(tools)
    assert "## bash" in ins
    assert "run command" in ins
    assert '"command"' in ins
    assert FENCE in ins