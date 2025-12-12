# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)
c.LabApp.dev_mode = True
# To test with the RTC extension
# c.LabApp.extensions_in_dev_mode = True

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
