import os
def get_input_directory():
    return os.environ["TEXPAINT_TEST_INPUT"]


def get_output_directory():
    import os, tempfile
    return os.environ.get("TEXPAINT_OUT") or os.path.join(tempfile.gettempdir(), "texpaint_output")
