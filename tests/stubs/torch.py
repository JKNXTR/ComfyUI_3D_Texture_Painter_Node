# minimal stand-in so the nodes can be exercised without PyTorch (tensors are plain numpy arrays)
def from_numpy(a):
    return a
