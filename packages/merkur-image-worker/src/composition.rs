//! Fixed bounded composition IPC. Raw source/destination rectangles cross the
//! pipe without allocating a packed canvas in the trusted supervisor.

use merkur_graphics::command::Format;
use merkur_graphics::processing::{DecodeRequest, pixel_bytes};
use tokio::io::AsyncWriteExt;

use crate::{Failure, Worker, frame::Raster};

pub const REQUEST_BYTES: usize = 28;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub width: u32,
    pub height: u32,
    pub x: u32,
    pub y: u32,
    pub patch_width: u32,
    pub patch_height: u32,
    pub overwrite: bool,
}

impl Request {
    pub fn valid(self) -> bool {
        pixel_bytes(self.width, self.height, 4).is_some()
            && pixel_bytes(self.patch_width, self.patch_height, 4).is_some()
            && self
                .x
                .checked_add(self.patch_width)
                .is_some_and(|x| x <= self.width)
            && self
                .y
                .checked_add(self.patch_height)
                .is_some_and(|y| y <= self.height)
    }

    pub fn output(self) -> DecodeRequest {
        DecodeRequest {
            format: Format::Rgba,
            compressed: false,
            base64: false,
            width: self.width,
            height: self.height,
            inflated_bytes: 0,
        }
    }

    pub fn encode(self) -> [u8; REQUEST_BYTES] {
        let mut out = [0; REQUEST_BYTES];
        for (value, word) in [
            self.width,
            self.height,
            self.x,
            self.y,
            self.patch_width,
            self.patch_height,
        ]
        .into_iter()
        .zip(out.chunks_exact_mut(4))
        {
            word.copy_from_slice(&value.to_le_bytes());
        }
        out[24] = u8::from(self.overwrite);
        out
    }

    pub fn decode(bytes: &[u8; REQUEST_BYTES]) -> Option<Self> {
        if bytes[24] > 1 || bytes[25..] != [0; 3] {
            return None;
        }
        let word = |offset| {
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("fixed header"))
        };
        let request = Self {
            width: word(0),
            height: word(4),
            x: word(8),
            y: word(12),
            patch_width: word(16),
            patch_height: word(20),
            overwrite: bytes[24] != 0,
        };
        request.valid().then_some(request)
    }
}

impl Worker {
    /// Rectangles name validated immutable rasters. A source crop is allowed;
    /// the helper receives no addresses, scene identifiers or ambient authority.
    pub async fn compose_input(
        &mut self,
        request: Request,
        base: &impl Raster,
        base_origin: [u32; 2],
        patch: &impl Raster,
        patch_origin: [u32; 2],
    ) -> Result<(), Failure> {
        if self.finished_input
            || self.composition != Some(request)
            || !request.valid()
            || !fits(base, base_origin, [request.width, request.height])
            || !fits(
                patch,
                patch_origin,
                [request.patch_width, request.patch_height],
            )
        {
            return Err(Failure::Input);
        }
        let result = tokio::time::timeout(crate::VALIDATION_WALL_BUDGET, async {
            let input = self.input.as_mut().ok_or(Failure::Input)?;
            send(input, base, base_origin, [request.width, request.height]).await?;
            send(
                input,
                patch,
                patch_origin,
                [request.patch_width, request.patch_height],
            )
            .await
        })
        .await
        .unwrap_or(Err(Failure::WorkBudget));
        if result.is_err() {
            self.cancel_in_place().await;
        } else {
            self.finished_input = true;
            self.input.take();
        }
        result
    }
}

fn fits(source: &impl Raster, origin: [u32; 2], size: [u32; 2]) -> bool {
    origin[0]
        .checked_add(size[0])
        .is_some_and(|end| end <= source.width())
        && origin[1]
            .checked_add(size[1])
            .is_some_and(|end| end <= source.height())
}

async fn send(
    input: &mut tokio::process::ChildStdin,
    source: &impl Raster,
    origin: [u32; 2],
    size: [u32; 2],
) -> Result<(), Failure> {
    for y in origin[1]..origin[1] + size[1] {
        let mut x = origin[0];
        while x < origin[0] + size[0] {
            let run = source.run(x, y);
            let length = run.len().min((origin[0] + size[0] - x) as usize * 4);
            input
                .write_all(&run[..length])
                .await
                .map_err(|_| Failure::Input)?;
            x += (length / 4) as u32;
        }
    }
    Ok(())
}
