//! Extent-aware grid movement. Ordinary full-screen scrolling still rotates the
//! ring without visiting live images. Only the rows actually being retired need
//! tail migration; a partial scroll visits attachments in its affected rows.

use std::sync::Arc;

use super::anchor::AnchorState;

#[derive(Default)]
pub(super) struct ImageMotion(Option<Arc<AnchorState>>);

impl ImageMotion {
    pub fn push(&mut self, state: Arc<AnchorState>, target_line: i32) {
        {
            let mut image = state.image.as_ref().expect("image attachment").lock();
            image.target_line = target_line;
            image.next = self.0.take();
        }
        self.0 = Some(state);
    }

    pub fn pop(&mut self) -> Option<(Arc<AnchorState>, i32)> {
        let state = self.0.take()?;
        let target = {
            let mut image = state.image.as_ref().expect("image attachment").lock();
            self.0 = image.next.take();
            image.target_line
        };
        Some((state, target))
    }
}

impl Drop for ImageMotion {
    fn drop(&mut self) {
        // Unwind/teardown must not recursively drop an image-sized linked list
        // or leave a live attachment pointing at a row it no longer owns.
        while let Some((state, _)) = self.pop() {
            state.retire(true);
        }
    }
}
