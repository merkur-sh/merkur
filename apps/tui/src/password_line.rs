//! A password line owns every plaintext byte and never reads the next command.

use std::io::{self, Read};
use zeroize::{Zeroize, Zeroizing};

pub fn read(reader: &mut impl Read) -> io::Result<Option<Zeroizing<String>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    let mut byte = Zeroizing::new([0; 1]);
    let mut present = false;
    loop {
        match reader.read(&mut *byte) {
            Ok(0) => break,
            Ok(_) => {
                present = true;
                let newline = byte[0] == b'\n';
                if !newline {
                    crate::sensitive::append_bytes(&mut bytes, &*byte);
                }
                byte.zeroize();
                if newline {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                byte.zeroize();
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    // An empty line is a password attempt; an empty stream is missing input.
    if !present {
        return Ok(None);
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "password is not UTF-8"))?;
    let text = text.trim_end_matches('\r');
    let mut password = Zeroizing::new(String::with_capacity(text.len()));
    password.push_str(text);
    Ok(Some(password))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn a_long_utf8_password_does_not_read_the_following_command() {
        let expected = "密碼🔑".repeat(4097);
        let mut input = Cursor::new(format!("{expected}\r\nnext-command\n").into_bytes());
        let password = read(&mut input).unwrap().unwrap();
        assert_eq!(&*password, &expected);
        assert_eq!(input.position() as usize, expected.len() + 2);
        let mut following = String::new();
        input.read_to_string(&mut following).unwrap();
        assert_eq!(following, "next-command\n");
    }

    #[test]
    fn eof_finishes_a_password_but_an_empty_stream_has_no_password() {
        let mut input = Cursor::new("secret🔑".as_bytes());
        assert_eq!(&*read(&mut input).unwrap().unwrap(), "secret🔑");
        assert!(read(&mut input).unwrap().is_none());
        assert!(read(&mut Cursor::new(b"")).unwrap().is_none());
    }

    #[test]
    fn an_empty_line_is_read_without_consuming_the_next_command() {
        let mut input = Cursor::new(b"\ncommand");
        assert!(read(&mut input).unwrap().unwrap().is_empty());
        assert_eq!(input.position(), 1);
    }

    #[test]
    fn invalid_utf8_is_rejected_before_creating_a_password_string() {
        let mut input = Cursor::new(b"secret\xff\ncommand");
        assert_eq!(
            read(&mut input).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(input.position(), 8);
    }
}
