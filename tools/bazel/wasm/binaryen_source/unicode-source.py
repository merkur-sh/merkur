"""Original Unicode9 data, LLVM generator, and Binaryen publisher source join."""
import ast
import contextlib
import hashlib
import io
import sys


ROLES = ('generator', 'data', 'readme', 'original_cpp', 'terms', 'license')


def capture(files, pins):
    if set(files) != set(ROLES):
        raise ValueError('Unicode-derived input requires all original generator/data/terms/license Files')
    result = {}
    for role in ROLES:
        raw = files[role].read_bytes()
        pin = pins['unicode'][role]
        if len(raw) != pin['size'] or hashlib.sha256(raw).hexdigest() != pin['sha256']:
            raise ValueError('Unicode original publisher File differs: ' + role)
        result[role] = raw
    return result


def generated_source(original, data, uri):
    # Execute the pinned original algorithm. Remove only its network acquisition
    # statement: acquisition belongs outside the immutable action, and its actual
    # original UTF8 data is already a mandatory declared input. No emitted source
    # or algorithm is rewritten.
    tree = ast.parse(original, filename='original-unicode-case-fold.py')
    acquisition = [node for node in tree.body if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == 'f' for target in node.targets)]
    if len(acquisition) != 1 or ast.unparse(acquisition[0].value) != 'urlopen(sys.argv[1])':
        raise ValueError('Original Unicode generator acquisition statement differs')
    tree.body.remove(acquisition[0])
    namespace = {'__name__': 'original_unicode_algorithm', 'f': io.StringIO(data.decode('utf-8'))}
    argv, output = sys.argv, io.StringIO()
    try:
        sys.argv = ['original-unicode-case-fold.py', uri]
        with contextlib.redirect_stdout(output):
            exec(compile(tree, 'original-unicode-case-fold.py', 'exec'), namespace)
    finally:
        sys.argv = argv
    return output.getvalue().encode('utf-8')


def join(source, pins, files):
    raw = capture(files, pins)
    unicode = pins['unicode']
    if unicode['source_uri'] != 'http://www.unicode.org/Public/9.0.0/ucd/CaseFolding.txt':
        raise ValueError('Original LLVM Unicode source URI differs')
    for role in ['data', 'readme']:
        if b'http://www.unicode.org/terms_of_use.html' not in raw[role]:
            raise ValueError('Original Unicode9 input lacks its publisher terms relation')
    if (b'# CaseFolding-9.0.0.txt' not in raw['data'] or
            b'for Version 9.0.0 of the Unicode Standard.' not in raw['readme']):
        raise ValueError('Original Unicode data version differs')
    if (unicode['terms']['url'] != 'https://www.unicode.org/terms_of_use.html' or
            unicode['terms']['effective'] != 'https://www.unicode.org/copyright.html' or
            b'All Unicode Data Files and Unicode Software are subject to the terms' not in raw['terms'] or
            b'<a href="https://www.unicode.org/license.txt">Unicode License v3</a>' not in raw['terms'] or
            not raw['license'].startswith(b'UNICODE LICENSE V3\n')):
        raise ValueError('Unicode original terms/license relation differs')
    generated = generated_source(raw['generator'], raw['data'], unicode['source_uri'])
    if generated != raw['original_cpp']:
        raise ValueError('Original Unicode generator/data do not reproduce the original LLVM source File')
    # Bind exact edits observed in Binaryen's original publisher archive. These
    # two removals affect command-example comments only; every resulting byte,
    # including the entire generated function, must match its original source.
    if unicode['publisher_source_edits'] != [{'offset': 315, 'removed': ' \\'},
                                             {'offset': 382, 'removed': ' \\'}]:
        raise ValueError('Original Binaryen Unicode publisher source edits differ')
    published = generated
    for edit in reversed(unicode['publisher_source_edits']):
        offset, removed = edit['offset'], edit['removed'].encode()
        if published[offset:offset + len(removed)] != removed:
            raise ValueError('Original Binaryen Unicode publisher edit bytes differ')
        published = published[:offset] + published[offset + len(removed):]
    member = unicode['source_member']
    if (member != 'third_party/llvm-project/UnicodeCaseFold.cpp' or
            hashlib.sha256(published).hexdigest() != unicode['published_cpp_sha256'] or
            source[member] != published):
        raise ValueError('Original Binaryen Unicode source differs from its publisher generator relation')
    return {'unicode-data-copyright': raw['data'].split(b'\n# Case Folding Properties', 1)[0],
            'unicode-readme': raw['readme'], 'unicode-terms': raw['terms'],
            'unicode-license': raw['license']}
