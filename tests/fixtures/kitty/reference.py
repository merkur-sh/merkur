"""Headless semantic oracle; run with the pinned Kitty 0.48.2 +runpy.

No GUI, GPU, terminal subprocess, or external-tool replay is involved. The
reference's C parser and graphics manager generate these observations. Command
construction, row intersection, PNG construction and every normative oracle
below are independent of Merkur's code.
"""
import base64
import json
import random
import struct
import sys
import zlib
from fractions import Fraction
from kitty.fast_data_types import Screen, set_options
from kitty.options.types import defaults

set_options(defaults)

class Replies:
    def __init__(self):
        self.data = b""
    def write(self, data):
        self.data += bytes(data)
    def __getattr__(self, name):
        return lambda *args: None

def command(header, pixels=None):
    if pixels is None:
        return "\x1b_G" + header + "\x1b\\"
    payload = base64.b64encode(pixels).decode()
    if len(payload) <= 4096:
        return "\x1b_G" + header + ";" + payload + "\x1b\\"
    return ''.join("\x1b_G" + (header + ',' if offset == 0 else '') +
        f'm={int(offset + 4096 < len(payload))};' + payload[offset:offset+4096] + "\x1b\\"
        for offset in range(0, len(payload), 4096))

# The ordering rule is protocol text: equal z-index images are ordered by client
# image id, lower first. Kitty sorts equal-z layers by its internal creation id.
ORDER = ('Kitty 0.48.2 cmp_by_zindex_and_image orders equal-z layers by internal image id, '
    'which follows creation order; the protocol gives the lower client image id the lower z-index.')

def loaded(screen, client):
    try:
        image = screen.grman.image_for_client_id(client)
    except RuntimeError:
        # A failed transmission leaves an entry without data. Its id answers
        # ENOENT exactly like an absent image; Merkur never publishes one.
        return None
    return image if image is not None and image['root_frame_data_loaded'] else None

def observe(screen, client):
    """Decoded frames, gaps and playback state; None when absent or unloadable."""
    image = loaded(screen, client)
    if image is None:
        return None
    width, height = image['width'], image['height']
    def rgba(data):
        data = bytes(data)
        if len(data) == 3 * width * height:
            data = b''.join(data[i:i + 3] + b'\xff' for i in range(0, len(data), 3))
        return data.hex()
    frames = [[image['root_frame_gap'], rgba(image['data'])]]
    frames += [[frame['gap'], rgba(frame['data'])] for frame in image['extra_frames']]
    return {"size": [width, height], "state": image['animation_state'],
        "current": image['current_frame_index'], "frames": frames}

class Repeat:
    """One input written `count` times as a single step, stored once."""
    def __init__(self, data, count):
        self.data, self.count = data, count

def write(screen, data):
    data = data.encode()
    while data:
        target = screen.test_create_write_buffer()
        count = screen.test_commit_write_buffer(data, target)
        data = data[count:]
        screen.test_parse_written_data()

def run(name, steps, ids=range(1, 5), images=()):
    replies = Replies()
    screen = Screen(replies, 8, 16, 100, 8, 16, 0, replies)
    observations = []
    for index, action in enumerate(steps):
        replies.data = b""
        if isinstance(action, tuple):
            screen.resize(action[1], action[0])
            event = {"resize": list(action)}
        elif isinstance(action, Repeat):
            for _ in range(action.count):
                write(screen, action.data)
            event = {"input": action.data, "repeat": action.count}
        else:
            write(screen, action)
            event = {"input": action}
        sources = {}
        for client in ids:
            image = loaded(screen, client)
            if image is not None:
                sources[image['internal_id']] = (client, image['width'], image['height'])
        # Unicode placeholder cells become layers when their lines are rendered,
        # as Kitty's renderer does before computing layers.
        screen.update_only_line_graphics_data()
        rows = []
        for order, layer in enumerate(screen.grman.update_layers(0, 0, 0, 1, 1, screen.columns, screen.lines, 8, 16)):
            client, width, height = sources[layer['image_id']]
            d, s = layer['dest_rect'], layer['src_rect']
            left, right, top, bottom = d['left'], d['right'], -d['top'], -d['bottom']
            x0, x1 = max(0, left), min(screen.columns, right)
            for row in range(screen.lines):
                y0, y1 = max(row, top), min(row + 1, bottom)
                if x0 >= x1 or y0 >= y1:
                    continue
                sx = lambda x: (s['left'] + (x - left) / (right - left) * (s['right'] - s['left'])) * width
                sy = lambda y: (s['top'] + (y - top) / (bottom - top) * (s['bottom'] - s['top'])) * height
                rows.append((row, order, [row, client, layer['z_index'], x0, x1, y0-row, y1-row, sx(x0), sx(x1), sy(y0), sy(y1)]))
        # Each row lists its slices in Kitty's draw order.
        rows = [fields for _, _, fields in sorted(rows, key=lambda row: row[:2])]
        event.update(replies=replies.data.decode(), cursor=[screen.cursor.x, screen.cursor.y], rows=rows)
        if images:
            event['images'] = {str(client): observe(screen, client) for client in images}
        normative = sorted(rows, key=lambda fields: (fields[0], fields[2], fields[1]))
        if normative != rows:
            deviate(event, ORDER, rows=normative)
        observations.append(event)
        if name.startswith('grid-trace') and screen.grman.image_for_client_id(1) is None:
            # Source reclamation after screen clearing/scroll-out is a storage
            # policy, not placement geometry. Kitty frees unused sources here;
            # Merkur retains them under its quota. Re-establish the same source
            # explicitly so later operations exercise geometry in both cores.
            steps.insert(index + 1, grid_upload)
    return {"name": name, "steps": observations}

def deviate(step, reason, **normative):
    """Retain the upstream observation beside an explicit normative oracle."""
    reasons = [text for text in step.get('reference_deviation', '').split('\n') if text]
    step['reference_deviation'] = '\n'.join(reasons + [reason])
    for key, value in normative.items():
        step['normative_' + key] = value

pixels = bytes([255, 0, 0, 255]) * (16 * 24)
upload = command('a=t,i=1,f=32,s=16,v=24', pixels)
cases = []
# Explicit/natural/aspect-preserving size, source crops, cell offsets and layers.
for c, r in [(0, 0), (4, 0), (0, 3), (4, 3)]:
    for crop in ['', ',x=3,y=5,w=9,h=11', ',x=12,y=20,w=12,h=10']:
        for offset in ['', ',X=3,Y=7']:
            place = command(f'a=p,i=1,p=2,c={c},r={r},C=1{crop}{offset}')
            cases.append(run(f'layout-{c}-{r}{crop}{offset}', [upload, '\x1b[2;3H', place]))
# Reused IDs, relative dependencies, response families and silent deletion.
cases.append(run('identity-relative-delete', [upload,
    command('a=p,i=1,p=1,c=3,r=2,C=1'),
    command('a=p,i=1,p=2,P=1,Q=1,H=4,V=1,c=2,r=1,C=1'),
    '\x1b[3;2H', command('a=p,i=1,p=1,c=4,r=3,C=1'),
    command('a=d,d=i,i=1,p=1'), command('a=p,i=4'),
    command('a=T,i=1,f=32,s=1,v=1,c=2,r=2,C=1', b'\x00\xff\x00\xff'),
    command('a=d,d=A'), command('a=q,i=2,f=32,s=1,v=1', b'\xff\x00\x00\xff')]))
# Reference grid transitions stay deterministic and exercise visible clipping,
# history, margins, both screens and actual terminal resize/reflow.
rng = random.Random(0x4b4750)
grid_upload = command('a=t,i=1,f=32,s=24,v=48', bytes([255, 0, 0, 255]) * (24 * 48))
steps = [grid_upload]
for index in range(120):
    choice = rng.randrange(8)
    if choice == 0:
        steps += [f'\x1b[{rng.randrange(1,7)};{rng.randrange(1,12)}H', command(f'a=p,i=1,p={index+1},C=1')]
    elif choice == 1: steps.append('\x1b[2S')
    elif choice == 2: steps.append('\x1b[1T')
    elif choice == 3: steps.append('\x1b[2;6r\x1b[1S\x1b[r')
    elif choice == 4: steps.append('\x1b[?1049h\x1b[?1049l')
    elif choice == 5: steps.append((rng.choice([12,16,20]), 8))
    elif choice == 6: steps.append('\x1b[2J')
    else: steps.append(command('a=d,d=a'))
cases.append(run('grid-trace-0x4b4750', steps))
cases.append(run('alternate-resize', ['\x1b[?1049h', upload,
    '\x1b[2;3H', command('a=p,i=1,p=1,c=3,r=5,C=1'), (12, 6), (20, 10)]))
scaled = run('scaled-margin-sampling', [upload, '\x1b[2;7H',
    command('a=p,i=1,p=1,c=3,r=3,C=1'), '\x1b[2;6r\x1b[1S\x1b[r'])
deviate(scaled['steps'][-1],
    'Kitty 0.48.2 scroll_filter_margins_func subtracts unscaled cell.height from src_height, '
    'then retains explicit num_rows while update_layers recomputes the destination. '
    'Merkur clips one of three displayed rows without changing the 24/3 source-pixels-per-row transform.',
    rows=[[1, 1, 0, 6, 9, 0, 1, 0, 16, 8, 16], [2, 1, 0, 6, 9, 0, 1, 0, 16, 16, 24]])
cases.append(scaled)
# The cursor advances like printed text: onto the image's last row past its last
# column, onto the next line after the final column, scrolling at the bottom.
cases.append(run('cursor-advance', [upload,
    '\x1b[2;3H' + command('a=p,i=1,p=1,c=2,r=1'),
    '\x1b[2;15H' + command('a=p,i=1,p=2,c=2,r=2'),
    '\x1b[7;3H' + command('a=p,i=1,p=3,c=2,r=3'),
    '\x1b[8;15H' + command('a=p,i=1,p=4,c=4,r=2'),
    '\x1b[4;1H' + command('a=p,i=1,p=5,X=3,Y=12')]))
# An image taller than the page scrolls it once per line crossed, however many:
# every placement travels the whole distance, including one already extending
# below the page, and the last one's scroll passes all of Merkur's history.
tall = ['\x1b[2;3H' + command('a=p,i=1,p=1,c=2,r=20'),
    '\x1b[4;15H' + command('a=p,i=1,p=2,c=2,r=12')]
cases.append(run('cursor-advance-tall', [upload] + tall + [
    '\x1b[7;1H' + command('a=p,i=1,p=3,c=2,r=10,C=1'),
    '\x1b[1;5H' + command('a=p,i=1,p=4,c=2,r=13'),
    '\x1b[1;1H' + command('a=p,i=1,p=5,c=1,r=20000')]))
cases.append(run('cursor-advance-tall-alternate', ['\x1b[?1049h' + upload] + tall))
# A scroll region scrolls once per line the cursor passes its bottom, wherever
# the cursor started. Images crossing a margin stay; the cursor then clamps to
# the page, or to the margins in origin mode when its line before wrapping lay
# between them. Region images are one unscaled row, so none is partly clipped.
row_upload = command('a=t,i=2,f=32,s=16,v=16', bytes([0, 255, 0, 255]) * 256)
cases.append(run('cursor-advance-region', [upload + row_upload,
    '\x1b[3;6r\x1b[5;3H' + command('a=p,i=2,p=1,C=1'),
    '\x1b[6;15H' + command('a=p,i=2,p=2'),
    '\x1b[7;5H' + command('a=p,i=2,p=3'),
    '\x1b[1;9H' + command('a=p,i=1,p=4,c=2,r=7'),
    '\x1b[4;13H' + command('a=p,i=1,p=5,c=2,r=10'),
    '\x1b[?6h\x1b[3;1H' + command('a=p,i=2,p=6,C=1'),
    '\x1b[4;15H' + command('a=p,i=2,p=7'),
    '\x1b[1;1H' + command('a=p,i=1,p=8,c=1,r=9')]))

# Unicode placeholders. The first eight row/column diacritics of Kitty's
# rowcolumn-diacritics.txt encode 0-7.
DIACRITICS = (0x305, 0x30D, 0x30E, 0x310, 0x312, 0x33D, 0x33E, 0x33F)
def cell(*marks):
    return '\U0010EEEE' + ''.join(chr(DIACRITICS[mark]) for mark in marks)
quiet_upload = command('a=t,i=1,f=32,s=16,v=24,q=2', pixels)
# The 16x24 source fills a 4x3 virtual box of 8x16 cells exactly.
box = command('a=p,i=1,U=1,c=4,r=3')
cases.append(run('placeholder-inheritance', [quiet_upload, box,
    '\x1b[2;3H\x1b[38;5;1m' + cell(0, 0) + cell(0, 1) + cell(0, 2) + cell(0, 3),
    '\x1b[3;3H\x1b[31m' + cell(1) + cell() + cell() + cell(),
    '\x1b[4;3H' + cell(2, 0) + cell(2) + cell(2, 2) + cell(2, 3),
    '\x1b[6;1H' + cell() + cell() + cell(0, 3) + cell(1) + cell(2, 1) + cell() + cell(0, 0) + cell(0, 2),
    '\x1b[3;4H\x1b[39mx',
    '\x1b[6;4H\x1b[2P',
    '\x1b[6;1H\x1b[3@',
    '\x1b[1S',
    '\x1b[1;1H\x1b[2K']))
# 24-bit, indexed with a high byte, bright ANSI and indexed foreground identities.
identity = [66051, 33554474, 9, 1]
cases.append(run('placeholder-identity',
    [command(f'a=t,i={image},f=32,s=16,v=24,q=2', pixels) for image in identity] +
    [command(f'a=p,i={image},U=1,c=4,r=3,q=2') for image in identity[:3]] + [
    command('a=p,i=1,p=7,U=1,c=4,r=3'), command('a=p,i=1,p=8,U=1,c=4,r=3,z=5'),
    '\x1b[1;1H\x1b[38;2;1;2;3m' + cell(0, 0) + cell(),
    # The third diacritic carries the most significant id byte. Unmarked and
    # consecutive marked cells inherit it; a column jump does not.
    '\x1b[2;1H\x1b[38;5;42m' + cell(0, 0, 2) + cell() + cell(0, 2) + cell(0, 3, 2) + cell(1, 0) + cell(1, 1, 2),
    '\x1b[3;1H\x1b[91m' + cell(1, 0) + cell(),
    # Underline colour selects the placement; zero selects any virtual placement.
    '\x1b[4;1H\x1b[38;5;1;58;5;7m' + cell(2, 0) + '\x1b[58;5;8m' + cell(2, 1) +
        '\x1b[58;2;0;0;7m' + cell(2, 2) + '\x1b[59m' + cell(2, 3),
    '\x1b[5;1H\x1b[58;5;7m' + cell(1, 1) + '\x1b[58;5;8m' + cell() + cell(),
    '\x1b[6;1H\x1b[58;5;9m' + cell(0, 0) + '\x1b[38;5;77;59m' + cell(0, 1),
    command('a=d,d=i,i=1,p=7'),
    command('a=d,d=I,i=9')], ids=(1, 9, 66051, 33554474)))
# Kitty's placeholder layout rounds the fitted image to whole pixels and extends
# each run to its last cell, sampling transparent texels past the image edge.
# The protocol fits the whole image, preserving aspect ratio; the oracle centers
# the exact fit and clips every slice to the image.
fit = [(1, 8, 2), (2, 4, 4), (3, 0, 0)]
fit_steps = [quiet_upload] + [command(f'a=p,i=1,p={p},U=1,c={c},r={r},q=2') for p, c, r in fit]
fit_runs = [
    [(0, 0, 0, 0, 8), (1, 0, 1, 0, 8)],
    [(2 + row, 0, row, 0, 4) for row in range(4)],
    [(2, 8, 0, 0, 2), (3, 8, 1, 0, 2)],
]
fit_steps += [
    '\x1b[1;1H\x1b[38;5;1;58;5;1m' + ''.join(cell(0, c) for c in range(8)) + '\r\n' + ''.join(cell(1, c) for c in range(8)),
    '\x1b[58;5;2m' + ''.join(f'\x1b[{3 + row};1H' + cell(row, 0) + cell() + cell() + cell() for row in range(4)),
    '\x1b[58;5;3m\x1b[3;9H' + cell(0, 0) + cell() + '\x1b[4;9H' + cell(1, 0) + cell(),
]
def fitted(runs, placement, cw=8, ch=16, width=16, height=24):
    _, columns, lines = placement
    if not columns:
        columns = -(-width // cw)
    if not lines:
        lines = -(-height // ch)
    scale = min(Fraction(columns * cw, width), Fraction(lines * ch, height))
    ox = (columns * cw - width * scale) / 2
    oy = (lines * ch - height * scale) / 2
    rows = []
    for row, column, box_row, box_column, count in runs:
        x0 = max(Fraction(box_column * cw), ox)
        x1 = min(Fraction((box_column + count) * cw), ox + width * scale)
        y0 = max(Fraction(box_row * ch), oy)
        y1 = min(Fraction((box_row + 1) * ch), oy + height * scale)
        if x0 < x1 and y0 < y1:
            rows.append([row, 1, -1] + [float(value) for value in (
                column + (x0 - box_column * cw) / cw, column + (x1 - box_column * cw) / cw,
                (y0 - box_row * ch) / ch, (y1 - box_row * ch) / ch,
                (x0 - ox) / scale, (x1 - ox) / scale, (y0 - oy) / scale, (y1 - oy) / scale)])
    return rows
placeholder_fit = run('placeholder-fit', fit_steps)
for index in range(3):
    normative = [row for prior in range(index + 1) for row in fitted(fit_runs[prior], fit[prior])]
    deviate(placeholder_fit['steps'][4 + index],
        'Kitty 0.48.2 grman_put_cell_image rounds the fitted image to whole pixels and extends '
        'each run to its final cell. The oracle centers the exact aspect-preserving fit and clips slices to the image.',
        rows=sorted(normative, key=lambda fields: fields[0]))
cases.append(placeholder_fit)
# Placeholder inheritance never crosses a line, including an autowrapped run.
# Width reflow of placeholder text is excluded: when a line gains rows,
# Alacritty moves earlier text into history while Kitty moves later text down.
cases.append(run('placeholder-wrap', [quiet_upload, box,
    '\x1b[1;15H\x1b[38;5;1m' + cell(0, 0) + cell() + cell() + cell(),
    '\x1b[4;10H' + cell(1, 0) + cell() + cell() + cell() + cell(2, 0) + cell(2, 1)]))
row_text = lambda row: cell(row, 0) + cell() + cell() + cell()
cases.append(run('placeholder-relative', [quiet_upload,
    command('a=t,i=2,f=32,s=2,v=2,q=2', bytes([0, 255, 0, 255]) * 4),
    command('a=p,i=1,p=1,U=1,c=4,r=3,q=2'),
    '\x1b[38;5;1;58;5;1m' + ''.join(f'\x1b[{3 + row};5H' + row_text(row) for row in range(3)),
    command('a=p,i=2,p=5,P=1,Q=1,H=1,V=1,c=2,r=1'),
    '\x1b[3;1H\x1b[2K',
    '\x1b[4;1H\x1b[2P',
    '\x1b[4;1H\x1b[2K\x1b[5;1H\x1b[2K',
    '\x1b[7;1H' + cell(0, 0),
    command('a=p,i=1,p=2,U=1,P=2,Q=5')]))
# Only id, range and number selectors address virtual placements.
cases.append(run('placeholder-delete', [quiet_upload, box,
    '\x1b[2;3H\x1b[38;5;1m' + cell(0, 0) + cell() + cell() + cell(),
    '\x1b[2;4H' + command('a=d'),
    command('a=d,d=A'), command('a=d,d=c'), command('a=d,d=P,x=4,y=2'),
    command('a=d,d=Q,x=4,y=2,z=0'), command('a=d,d=X,x=4'), command('a=d,d=Y,y=2'),
    command('a=d,d=Z,z=0'), command('a=d,d=r,x=1,y=1'), box, command('a=d,d=I,i=1'), box]))
cases.append(run('placeholder-stacking', [quiet_upload,
    command('a=t,i=2,f=32,s=2,v=2,q=2', bytes([0, 255, 0, 255]) * 4),
    command('a=p,i=1,U=1,c=4,r=3,z=5,q=2'),
    '\x1b[1;1H\x1b[38;5;1m' + cell(0, 0) + cell() + cell() + cell(),
    '\x1b[1;2H' + command('a=p,i=2,p=1,c=2,r=1,z=-1,C=1'),
    command('a=p,i=2,p=2,c=2,r=1,z=-2,C=1'), command('a=p,i=2,p=3,c=2,r=1,z=0,C=1')]))

# Stacking across the three text-relative strata, equal-z ties and extremes.
red, green, blue = bytes([255, 0, 0, 255]), bytes([0, 255, 0, 255]), bytes([0, 0, 255, 255])
clear, half = bytes(4), bytes([0, 0, 255, 128])
def tiny(image, color=red, quiet=1, extra=''):
    return command(f'a=t,i={image},f=32,s=2,v=2,q={quiet}{extra}', color * 4)
strata = [-2147483648, -1073741825, -1073741824, -1, 0, 1, 2147483647]
cases.append(run('z-order-strata', [''.join(tiny(image) for image in range(1, 8)), '\x1b[2;3H'] +
    [command(f'a=p,i={image + 1},c=2,r=1,z={strata[image]},C=1') for image in (3, 0, 6, 2, 5, 1, 4)],
    ids=range(1, 8)))
cases.append(run('z-order-ties', [tiny(5) + tiny(3) + tiny(4),
    command('a=t,I=20,f=32,s=2,v=2', red * 4), '\x1b[2;3H',
    command('a=p,i=5,c=2,r=1,C=1,q=1'), command('a=p,i=3,c=2,r=1,C=1,q=1'),
    command('a=p,i=4,p=2,c=2,r=1,C=1,q=1'), command('a=p,I=20,c=2,r=1,C=1'),
    command('a=p,i=4,p=1,c=2,r=1,C=1,q=1'), command('a=p,i=4,c=2,r=1,C=1,q=1'),
    tiny(3, green), command('a=p,i=3,c=2,r=1,C=1,q=1'),
    command('a=p,i=5,c=3,r=1,z=-1,C=1,q=1')], ids=(1, 3, 4, 5)))

# Reply suppression: q=1 hides success, q=2 hides failure too. Deletion never
# replies. A continuation's q replaces the first chunk's policy.
def chunked(image, first, final, data, extra=''):
    return (command(f'a=t,i={image},f=32,s=2,v=2,m=1{extra}{first}', data[:12]) +
        command(f'm=0{final}', data[12:]))
LEADING_SEPARATOR = ('Kitty 0.48.2 finish_command_response writes ",I=" after an absent image id. '
    'The reply has no leading separator.')
broken = b'not a zlib stream'[:16]
# Image numbers are allocated first: Kitty's free-id search also counts entries
# left by failed transmissions, which Merkur never publishes.
cases.append(run('quiet-replies', [
    command('a=t,I=13,f=32,s=2,v=2', red * 4), command('a=t,I=13,f=32,s=2,v=2,q=1', red * 4),
    tiny(3, quiet=0), tiny(4), tiny(5, quiet=2),
    command('a=t,i=6,f=32,s=0,v=2', red * 4), command('a=t,i=6,f=32,s=0,v=2,q=1', red * 4),
    command('a=t,i=6,f=32,s=0,v=2,q=2', red * 4),
    command('a=t,i=6,f=32,s=2,v=2,o=z', broken), command('a=t,i=6,f=32,s=2,v=2,o=z,q=1', broken),
    command('a=p,i=3,C=1'), command('a=p,i=3,p=3,C=1,q=1'), command('a=p,i=3,p=3,C=1,q=2'),
    command('a=p,i=9,C=1'), command('a=p,i=9,p=3,C=1,q=1'), command('a=p,i=9,C=1,q=2'),
    command('a=T,i=7,f=32,s=2,v=2,C=1', red * 4), command('a=T,i=8,f=32,s=2,v=2,C=1,q=1', red * 4),
    command('a=q,i=31,f=32,s=1,v=1', red), command('a=q,i=31,f=32,s=1,v=1,q=1', red),
    command('a=q,i=31,f=32,s=1,v=1,o=z', broken), command('a=q,i=31,f=32,s=1,v=1,o=z,q=1', broken),
    command('a=q,i=31,f=32,s=1,v=1,o=z,q=2', broken),
    command('a=f,i=3,s=2,v=2', green * 4), command('a=f,i=3,s=2,v=2,q=1', green * 4),
    command('a=f,i=9,s=2,v=2', green * 4), command('a=f,i=9,s=2,v=2,q=1', green * 4),
    command('a=f,i=9,s=2,v=2,q=2', green * 4),
    command('a=a,i=3,c=2'), command('a=a,i=9,c=2'), command('a=a,i=9,c=2,q=1'), command('a=a,i=9,c=2,q=2'),
    command('a=c,i=3,r=2,c=1,w=1,h=1'), command('a=c,i=9,r=2,c=1'), command('a=c,i=3,r=2,c=1,x=2,q=1'),
    command('a=c,i=3,r=2,c=1,x=2,q=2'),
    command('a=d,d=i,i=3,p=3'), command('a=d,d=i,i=9'), command('a=d,d=I,i=8'),
    command('a=d,d=i,i=3,I=13'), command('a=d,d=i,i=3,I=13,q=1'), command('a=d,d=i,i=3,I=13,q=2'),
    command('a=t,i=10,I=13,f=32,s=2,v=2', red * 4),
    command('a=p,I=13,p=4,C=1'), command('a=p,I=77,C=1'), command('a=p,I=77,C=1,q=1'),
    chunked(11, ',q=1', '', red * 4), chunked(12, '', ',q=1', red * 4),
    chunked(13, '', ',q=2', broken, ',o=z'), chunked(14, ',q=2', ',q=1', broken, ',o=z'),
    chunked(15, ',q=1', '', broken, ',o=z'),
], ids=range(1, 16)))
for step in cases[-1]['steps']:
    if step['input'].startswith('\x1b_Ga=p,I=77'):
        deviate(step, LEADING_SEPARATOR, replies='\x1b_GI=77;ENOENT\x1b\\')

# Every delete selector against one layout: two placements of image 2, a
# relative child of image 1 and an unplaced image 4. The cursor ends at (3, 1).
delete_setup = (tiny(1) + tiny(2) + tiny(3) + tiny(4) +
    '\x1b[2;3H' + command('a=p,i=1,p=1,c=2,r=2,C=1,q=1') +
    '\x1b[4;6H' + command('a=p,i=2,p=1,c=3,r=1,z=5,C=1,q=1') +
    '\x1b[6;1H' + command('a=p,i=2,p=2,c=1,r=1,z=-3,C=1,q=1') +
    command('a=p,i=3,p=1,P=1,Q=1,H=3,V=1,c=1,r=1,q=1') + '\x1b[2;4H')
for label, control in [('default', ''), ('a', 'd=a'), ('A', 'd=A'),
        ('i', 'd=i,i=2'), ('I', 'd=I,i=2'), ('i-placement', 'd=i,i=2,p=2'),
        ('I-placement', 'd=I,i=2,p=2'), ('I-unplaced', 'd=I,i=4'), ('i-parent', 'd=i,i=1'),
        ('I-parent', 'd=I,i=1'), ('c', 'd=c'), ('C', 'd=C'), ('p', 'd=p,x=3,y=2'),
        ('P', 'd=P,x=3,y=2'), ('P-child', 'd=P,x=6,y=3'), ('q', 'd=q,x=7,y=4,z=5'),
        ('Q', 'd=Q,x=7,y=4,z=5'), ('q-other-z', 'd=q,x=7,y=4,z=0'), ('r', 'd=r,x=2,y=3'),
        ('R', 'd=R,x=2,y=4'), ('R-reversed', 'd=R,x=3,y=2'), ('x', 'd=x,x=6'), ('X', 'd=X,x=3'),
        ('y', 'd=y,y=4'), ('Y', 'd=Y,y=2'), ('z', 'd=z,z=-3'), ('Z', 'd=Z,z=-3'), ('Z-parent', 'd=Z,z=0'),
        ('f', 'd=f,i=1'), ('F', 'd=F,i=2'), ('F-unplaced', 'd=F,i=4'), ('unknown', 'd=b,i=1'),
        ('missing-cell', 'd=p,i=1'), ('missing-image', 'd=F,i=99'), ('both-ids', 'd=i,i=1,I=3')]:
    cases.append(run(f'delete-{label}', [delete_setup,
        command('a=d' + (',' + control if control else '')),
        command('a=p,i=1,p=9,C=1') + command('a=p,i=3,p=9,C=1') + command('a=p,i=4,p=9,C=1')],
        images=range(1, 5)))
# Kitty matches cell selectors against a relative placement's creation cursor,
# (0, 5) here, instead of the cell where the placement is displayed.
RELATIVE = ('Kitty 0.48.2 matches cell delete selectors against the cursor at which a relative placement '
    'was created. The relative child displayed at (5, 2) intersects the selected cell.')
child = lambda rows: [row for row in rows if row[1] != 3 or row[3] != 5.0]
for case in cases:
    if case['name'] == 'delete-x':
        for step in case['steps'][1:]:
            deviate(step, RELATIVE, rows=child(step['rows']))
    if case['name'] == 'delete-P-child':
        freed = lambda step: dict(step['images'], **{'3': None})
        deviate(case['steps'][1], RELATIVE, rows=child(case['steps'][1]['rows']), images=freed(case['steps'][1]))
        probe = case['steps'][2]
        deviate(probe, RELATIVE, rows=[row for row in child(probe['rows']) if row[1] != 3],
            images=freed(probe), replies='\x1b_Gi=1,p=9;OK\x1b\\\x1b_Gi=3,p=9;ENOENT\x1b\\\x1b_Gi=4,p=9;OK\x1b\\')
number_setup = (command('a=t,I=13,f=32,s=2,v=2,q=1', red * 4) + command('a=t,I=13,f=32,s=2,v=2,q=1', green * 4) +
    command('a=t,I=14,f=32,s=2,v=2,q=1', blue * 4) +
    '\x1b[2;3H' + command('a=p,I=13,p=1,c=2,r=1,C=1,q=1') + '\x1b[3;3H' + command('a=p,i=1,p=1,c=2,r=1,C=1,q=1') +
    '\x1b[4;3H' + command('a=p,I=13,p=2,c=2,r=1,C=1,q=1') + '\x1b[5;3H' + command('a=p,I=14,c=2,r=1,C=1,q=1'))
for label, control in [('n', 'd=n,I=13'), ('N', 'd=N,I=13'), ('n-placement', 'd=n,I=13,p=2'),
        ('N-placement', 'd=N,I=13,p=2'), ('N-missing', 'd=N,I=99')]:
    cases.append(run(f'delete-{label}', [number_setup, command('a=d,' + control),
        '\x1b[7;1H' + command('a=p,I=13,p=3,C=1')], images=range(1, 4)))

# Formats and compression. PNGs are constructed here from their chunk grammar.
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
def png(width, height, depth, color, rows, extra=b'', interlace=0):
    raw = rows if interlace else b''.join(b'\x00' + row for row in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, color, 0, 0, interlace))
        + extra + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
def gamma(value):
    return chunk(b'gAMA', struct.pack('>I', value))
def adam7(width, height, pixel):
    """Filtered scanlines of the seven Adam7 passes; empty passes contribute nothing."""
    raw = b''
    for x0, y0, dx, dy in [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]:
        if x0 < width:
            for y in range(y0, height, dy):
                raw += b'\x00' + b''.join(pixel(x, y) for x in range(x0, width, dx))
    return raw
palette = chunk(b'PLTE', bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])) + chunk(b'tRNS', bytes([255, 0, 128]))
gray = [bytes([0, 1, 2, 16, 32, 64, 100, 128, 150, 200, 254, 255])]
interlaced = png(5, 5, 8, 2, adam7(5, 5, lambda x, y: bytes([x * 50, y * 50, x * 10 + y])), interlace=1)
pngs = [
    png(2, 2, 8, 6, [bytes([255, 0, 0, 255, 0, 255, 0, 128]), bytes([0, 0, 255, 0, 10, 20, 30, 40])]),
    png(2, 1, 8, 2, [bytes([1, 2, 3, 250, 251, 252])]),
    png(12, 1, 8, 0, gray),
    png(2, 1, 8, 4, [bytes([77, 10, 200, 255])]),
    png(4, 1, 8, 3, [bytes([0, 1, 2, 3])], extra=palette),
    png(4, 1, 2, 3, [bytes([0b00011011])], extra=palette),
    png(8, 1, 1, 0, [bytes([0b10110001])]),
    png(2, 1, 16, 6, [bytes([0x80, 0xff, 0x00, 0x7f, 0xff, 0x00, 0x12, 0x34, 0x00, 0x01, 0xff, 0xfe, 0x7f, 0xff, 0x80, 0x00])]),
    interlaced,
]
cases.append(run('format-png', [command(f'a=t,i={index + 1},f=100,q=1', data) for index, data in enumerate(pngs)] +
    ['\x1b[2;2H' + command('a=T,i=10,f=100,C=1', pngs[2])], ids=range(1, 11), images=range(1, 11)))
gammas = [
    png(12, 1, 8, 0, gray, extra=gamma(100000)),
    png(12, 1, 8, 0, gray, extra=gamma(45455)),
    png(12, 1, 8, 0, gray, extra=gamma(47000)),
    png(12, 1, 8, 0, gray, extra=gamma(50000)),
    png(12, 1, 8, 0, gray, extra=gamma(22727)),
    png(12, 1, 8, 0, gray, extra=chunk(b'sRGB', b'\x00') + gamma(100000)),
    png(4, 1, 8, 3, [bytes([0, 1, 2, 3])], extra=gamma(100000) + palette),
    png(3, 1, 8, 6, [bytes([0, 128, 255, 77, 16, 200, 1, 128, 250, 250, 250, 0])], extra=gamma(100000)),
    png(2, 1, 16, 2, [bytes([0x80, 0x00, 0x40, 0x00, 0x20, 0x00, 0x80, 0xff, 0x40, 0xff, 0x20, 0xff])], extra=gamma(100000)),
]
cases.append(run('format-png-gamma', [command(f'a=t,i={index + 1},f=100,q=1', data) for index, data in enumerate(gammas)],
    ids=range(1, 10), images=range(1, 10)))
noise = random.Random(0x706e67)
large = png(48, 32, 8, 6, [bytes(noise.randrange(256) for _ in range(48 * 4)) for _ in range(32)])
cases.append(run('format-raw-compressed', [
    command('a=t,i=1,f=24,s=2,v=1', bytes([1, 2, 3, 4, 5, 6])),
    command('a=t,i=2,f=24,s=2,v=1,o=z', zlib.compress(bytes([1, 2, 3, 4, 5, 6]))),
    command('a=t,i=3,f=32,s=1,v=2,o=z', zlib.compress(bytes([1, 2, 3, 4, 5, 6, 7, 8]))),
    command(f'a=t,i=4,f=100,o=z,S={len(pngs[1])}', zlib.compress(pngs[1])),
    '\x1b[2;2H' + command('a=T,i=5,f=24,s=3,v=2,o=z,C=1', zlib.compress(bytes(range(18)))),
    '\x1b[4;2H' + command('a=T,i=6,f=100', large),
    command('a=t,i=7,f=100,o=z', zlib.compress(pngs[1])),
    command('a=t,i=7,f=100,o=z,S=12', zlib.compress(pngs[1])),
    command('a=t,i=7,f=32,s=1,v=1,o=z', zlib.compress(bytes(3))),
    command('a=t,i=7,f=32,s=1,v=1,o=z', zlib.compress(bytes(5))),
    command('a=t,i=7,f=24,s=2,v=1', bytes(5)),
    command('a=t,i=7,f=100', b'not a png'),
    command('a=p,i=7')], ids=range(1, 8), images=range(1, 8)))

# Animation: frame composition, gaps, control, composition and frame deletion.
base = command('a=t,i=1,f=32,s=2,v=2,q=1', red * 4)
def frame(extra, data):
    return command('a=f,i=1' + extra, data)
cases.append(run('animation-frames', [base,
    frame(',s=2,v=2', green * 4),
    frame(',x=1,y=1,s=1,v=1', blue),
    frame(',x=1,y=0,s=1,v=1,Y=4278190335', half),
    frame(',x=0,y=1,s=2,v=1,c=1', blue * 2),
    frame(',x=1,y=0,s=1,v=1,c=2', half),
    frame(',r=3,x=0,y=0,s=1,v=1', green),
    frame(',r=4,c=1,x=0,y=1,s=2,v=1', half * 2),
    frame(',s=2,v=2,f=24', bytes([9, 8, 7]) * 4),
    frame(',s=2,v=2,o=z', zlib.compress(blue * 4)),
    # An absent base frame and an oversized patch fail; editing the frame after
    # the last one, or any later frame number, appends.
    frame(',c=20,s=2,v=2', green * 4),
    frame(',s=3,v=1', green * 3),
    frame(',r=9,s=2,v=2', green * 4),
    frame(',r=20,x=1,y=1,s=1,v=1', blue),
    frame(',s=2,v=2,q=1', blue * 4)], images=(1,)))
# Animation control applies each valid field; an absent frame or unknown state
# is ignored without a reply.
cases.append(run('animation-gaps-control', [base,
    frame(',s=2,v=2,z=-5', green * 4), frame(',s=2,v=2,z=250', blue * 4), frame(',s=2,v=2', red * 4),
    frame(',r=2,s=1,v=1', blue), frame(',r=3,z=90,s=1,v=1', red),
    command('a=a,i=1,r=1,z=77'), command('a=a,i=1,r=2,z=33'), command('a=a,i=1,r=4,z=-1'),
    command('a=a,i=1,c=3'), command('a=a,i=1,s=2'), command('a=a,i=1,s=1'),
    command('a=a,i=1,c=9'), command('a=a,i=1,r=9,z=10'), command('a=a,i=1,s=9'),
    command('a=a,i=1,s=2,c=9,r=9,z=5'), command('a=a,i=1,s=1,c=0,r=0,z=5,v=0'),
    command('a=a,i=1,s=3,v=4'), command('a=a,i=1,s=1,c=4'), command('a=a,i=1,c=1,v=1'),
    frame(',s=2,v=2', green * 4)], images=(1,)))
cases.append(run('animation-static-control', [base, command('a=a,i=1,r=1,z=30'),
    command('a=a,i=1,c=1'), command('a=a,i=1,s=3'), command('a=a,i=1,s=1')], images=(1,)))
cases.append(run('animation-compose', [base,
    frame(',s=2,v=2', bytes(green + blue + half + clear)),
    frame(',s=2,v=2', half * 4),
    command('a=c,i=1,r=2,c=1,w=1,h=2,X=1,Y=0,x=0,y=0'),
    command('a=c,i=1,r=3,c=2,w=1,h=1'),
    command('a=c,i=1,r=3,c=2,w=1,h=1,x=1,C=1'),
    command('a=c,i=1,r=2,c=2,w=1,h=1,X=1,x=0'),
    command('a=c,i=1,r=4,c=1'), command('a=c,i=1,r=2,c=5'), command('a=c,i=1,c=1'),
    command('a=c,i=1,r=2,c=1,w=3'), command('a=c,i=1,r=2,c=1,x=1'), command('a=c,i=1,r=2,c=1,w=1,X=2'),
    command('a=c,i=1,r=1,c=1'), command('a=c,i=1,r=1,c=1,w=1,h=1,x=1,y=1')], images=(1,)))
cases.append(run('animation-delete', [base,
    frame(',s=2,v=2,z=11', green * 4), frame(',s=2,v=2,z=22', blue * 4), frame(',s=2,v=2,z=33', red * 4),
    '\x1b[2;3H' + command('a=p,i=1,c=2,r=1,C=1,q=1'),
    command('a=a,i=1,c=3'), command('a=d,d=f,i=1,r=2'), command('a=d,d=f,i=1'),
    command('a=d,d=F,i=1,r=9'), command('a=d,d=f,i=1'), command('a=d,d=F,i=1')], images=(1,)))
cases.append(run('animation-number', [command('a=t,I=7,f=32,s=2,v=2', red * 4),
    command('a=f,I=7,s=2,v=2', green * 4), command('a=a,I=7,c=2'),
    command('a=f,I=7,s=2,v=2,m=1', green * 3) + command('a=f,m=0', green)], images=(1,)))
steps = cases[-1]['steps']
deviate(steps[1], LEADING_SEPARATOR + ' A frame reply names the resolved image id.',
    replies='\x1b_Gi=1,I=7,r=2;OK\x1b\\')
deviate(steps[3], 'Kitty 0.48.2 answers a chunked frame from its final chunk, which carries no image identity. '
    'Chunked replies use the first chunk, as they do for transmission.', replies='\x1b_Gi=1,I=7,r=3;OK\x1b\\')
# The protocol names X as the frame composition mode and composes every frame
# onto its canvas. Kitty 0.48.2 reads the frame command's C field instead, so
# X=1 blends and C=1 replaces, and it stores a full-size frame without a base
# frame exactly as transmitted, ignoring its Y canvas.
composition = run('animation-composition-mode', [base,
    frame(',x=1,y=0,s=1,v=1,c=1,X=1', half),
    frame(',x=1,y=0,s=1,v=1,c=1,C=1', half),
    frame(',r=1,x=0,y=1,s=1,v=1,X=1', clear),
    frame(',s=2,v=2,Y=4278190335', half * 4)], images=(1,))
over = bytes([127, 0, 128, 255])  # exact straight-alpha source-over of half on red
replaced, blended, edited = red + half + red + red, red + over + red + red, red + red + clear + red
x_blends = 'Kitty 0.48.2 ignores the frame composition key X=1 and blends.'
for index, reason, frames in [
        (1, x_blends, [red * 4, replaced]),
        (2, 'Kitty 0.48.2 replaces with C=1, which is not a frame composition key.', [red * 4, replaced, blended]),
        (3, x_blends, [edited, replaced, blended]),
        (4, 'Kitty 0.48.2 stores a full-size frame without a base frame as transmitted, '
            'instead of composing it onto its Y canvas.', [edited, replaced, blended, over * 4])]:
    step = composition['steps'][index]
    frames = [[0 if number == 0 else 40, data.hex()] for number, data in enumerate(frames)]
    deviate(step, reason, images={'1': dict(step['images']['1'], frames=frames)})
cases.append(composition)
# The protocol composes a new frame from its base frame's pixels when the frame
# is created. Kitty stores the frame as a delta over its base and recomposes it
# from the base frame's current pixels, so later base edits change it too.
based = run('animation-base-edit', [base,
    frame(',s=2,v=2', green * 4) + frame(',x=1,y=0,s=1,v=1,c=2', blue) + frame(',r=2,x=0,y=1,s=2,v=1', red * 2),
    frame(',r=2,x=0,y=0,s=1,v=1', blue),
    command('a=c,i=1,r=1,c=2,w=1,h=1')], images=(1,))
for index, frames in [(1, [red * 4, green * 2 + red * 2, green + blue + green * 2]),
        (2, [red * 4, blue + green + red * 2, green + blue + green * 2]),
        (3, [red * 4, red + green + red * 2, green + blue + green * 2])]:
    step = based['steps'][index]
    frames = [[0 if number == 0 else 40, data.hex()] for number, data in enumerate(frames)]
    deviate(step, 'Kitty 0.48.2 recomposes a frame from its base frame\'s current pixels, so editing the base '
        'changes the dependent frame. The protocol composes a frame when it is created.',
        images={'1': dict(step['images']['1'], frames=frames)})
cases.append(based)

# Size limits. Kitty answers data past its load buffer, a raw image's declared
# extent and ten bytes (1,024 for zlib input), with EFBIG, and bounds neither a
# chunk nor a header. Merkur bounds a chunk at 4,096 encoded bytes and an
# upload at ceil(64 MiB / 3) * 4, and answers both with EFBIG: every oversized
# chunk here also overflows Kitty's buffer. The reply names the first chunk.
def oversized(header, length):
    return '\x1b_G' + header + ';' + 'A' * length + '\x1b\\'
cases.append(run('size-chunk', [
    oversized('a=q,i=1,f=24,s=1,v=1', 4097),
    oversized('a=t,i=2,f=24,s=1,v=1', 4100), command('a=p,i=2,C=1'),
    oversized('a=t,i=3,f=24,s=1,v=1,q=1', 4100), oversized('a=t,i=3,f=24,s=1,v=1,q=2', 4100),
    oversized('a=t,i=4,f=24,s=1,v=1,o=z', 4100),
    command('a=t,i=5,f=24,s=1,v=1,m=1', bytes(3)) + oversized('m=0', 4100), command('a=p,i=5,C=1'),
    command('a=t,i=6,f=24,s=1,v=1,m=1', bytes(3)) + oversized('m=0,q=2', 4100),
    command('a=t,i=7,f=24,s=1,v=1', bytes(18)), command('a=p,i=7,C=1')],
    ids=range(1, 8), images=range(1, 8)))
# At Merkur's largest raw extent the two bounds meet: Kitty's buffer holds
# 4096 * 4096 * 4 + 10 bytes and Merkur's 89,478,488 encoded ones, so both
# admit 21,845 chunks of 4,096 and refuse the next. A later chunk without its
# upload names no image and is answered by neither.
chunk = 'A' * 4096
cases.append(run('size-upload', [
    '\x1b_Ga=t,i=1,f=32,s=4096,v=4096,m=1;' + chunk + '\x1b\\',
    Repeat('\x1b_Gm=1;' + chunk + '\x1b\\', 21844),
    '\x1b_Gm=1;' + chunk + '\x1b\\',
    '\x1b_Gm=0;AAAA\x1b\\', command('a=p,i=1,C=1')], ids=(1,)))
# Blend quantization is unspecified: Kitty truncates floating-point source-over.
for case in cases:
    if case['name'].startswith('animation-'):
        case['tolerance'] = 1
json.dump({"reference": "kitty 0.48.2", "dmg_sha256": "f804f58ee4b69c76f84eb3281e140748269a63f3f4a816015a8dec2a06d2b195", "cases": cases}, sys.stdout, indent=2)
print()
