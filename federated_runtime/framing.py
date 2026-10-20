"""Bounded binary frames; no pickle or network-supplied Python objects."""
import struct

MAX_FRAME=256*1024*1024


def _exact(stream,size):
    pieces=[]
    while size:
        piece=stream.read(size)
        if not piece:raise EOFError('Protocol pipe closed before its complete frame.')
        pieces.append(piece);size-=len(piece)
    return b''.join(pieces)


def read_frame(stream):
    size=struct.unpack('!I',_exact(stream,4))[0]
    if not 0<size<=MAX_FRAME:raise ValueError('Protocol frame exceeds the explicit resource bound.')
    return _exact(stream,size)


def write_frame(stream,value):
    if not isinstance(value,bytes) or not 0<len(value)<=MAX_FRAME:raise ValueError('Invalid bounded protocol bytes.')
    stream.write(struct.pack('!I',len(value))+value);stream.flush()
