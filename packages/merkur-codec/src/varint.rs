use crate::decode::CodecErr;

#[inline]
pub fn encode_varint_u32(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

#[inline]
pub fn decode_varint_u32(buf: &[u8], offset: &mut usize) -> Result<u32, CodecErr> {
    let mut value = 0u32;
    let mut shift = 0u32;
    for index in 0..5 {
        let byte = *buf.get(*offset).ok_or(CodecErr::Truncated)?;
        *offset += 1;
        // A u32 has only four payload bits left in the fifth byte. Rejecting
        // the other bits also rejects an unterminated five-byte encoding.
        if index == 4 && byte & 0xf0 != 0 {
            return Err(CodecErr::InvalidVarint);
        }
        let payload = byte & 0x7f;
        value |= u32::from(payload) << shift;
        if byte & 0x80 == 0 {
            // The encoder never emits redundant high zero groups. Accepting
            // them would give the same logical frame multiple wire encodings.
            if index > 0 && payload == 0 {
                return Err(CodecErr::InvalidVarint);
            }
            return Ok(value);
        }
        shift += 7;
    }
    Err(CodecErr::InvalidVarint)
}
