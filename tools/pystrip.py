#!/usr/bin/env python3
"""Strip docstrings, comments and reformat Python source via AST.

Usage: python3 pystrip.py input.py > output.py
       python3 pystrip.py input_dir/ output_dir/

Removes all docstrings and comments, collapses whitespace.
Not full obfuscation, but makes code significantly harder to read.
Variable/function names are preserved (AST limitation).
"""
import ast
import sys
import os
import shutil


def strip_file(source_code):
    """Parse Python source, remove docstrings, return unparsed code."""
    try:
        tree = ast.parse(source_code)
    except SyntaxError:
        return source_code  # return as-is if unparseable

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.ClassDef,
                             ast.Module, ast.AsyncFunctionDef)):
            if (node.body
                    and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)):
                node.body.pop(0)
                if not node.body:
                    node.body.append(ast.Pass())

    try:
        return ast.unparse(tree)
    except Exception:
        return source_code


def process_file(src, dst):
    """Strip a single .py file."""
    with open(src, 'r', encoding='utf-8', errors='replace') as f:
        code = f.read()

    # Preserve shebang
    shebang = ''
    if code.startswith('#!'):
        shebang = code.split('\n', 1)[0] + '\n'
        code = code.split('\n', 1)[1]

    stripped = strip_file(code)
    result = shebang + stripped + '\n'

    os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(result)


def process_dir(src_dir, dst_dir):
    """Strip all .py files in a directory tree."""
    for root, dirs, files in os.walk(src_dir):
        for fname in files:
            src_path = os.path.join(root, fname)
            rel = os.path.relpath(src_path, src_dir)
            dst_path = os.path.join(dst_dir, rel)

            if fname.endswith('.py'):
                process_file(src_path, dst_path)
            else:
                # Copy non-Python files as-is
                os.makedirs(os.path.dirname(dst_path), exist_ok=True)
                shutil.copy2(src_path, dst_path)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: pystrip.py <file.py|dir/> [output]", file=sys.stderr)
        sys.exit(1)

    src = sys.argv[1]

    if os.path.isdir(src):
        dst = sys.argv[2] if len(sys.argv) > 2 else src + '.stripped'
        process_dir(src, dst)
        print(f"Stripped directory: {src} -> {dst}", file=sys.stderr)
    else:
        if len(sys.argv) > 2:
            dst = sys.argv[2]
            process_file(src, dst)
        else:
            with open(src, 'r') as f:
                code = f.read()
            print(strip_file(code))
