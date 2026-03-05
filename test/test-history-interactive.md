# History Feature Test

## How to test manually:

1. **First run** - Add some commands:
   ```bash
   # In interactive mode, type a few commands:
   todoai -c  # or any interactive session
   > first command
   > second command  
   > third command
   > /exit
   ```

2. **Second run** - Verify history persists:
   ```bash
   todoai -c
   # Press UP arrow - should show "third command"
   # Press UP again - should show "second command"
   # Press UP again - should show "first command"
   # Press DOWN - should navigate forward through history
   ```

3. **Check config file**:
   ```bash
   cat ~/.config/todoai-cli/config.json | jq .input_history
   # Should show: ["first command", "second command", "third command"]
   ```

## Features:
- ✓ History persists across CLI runs (saved to config file)
- ✓ Up/Down arrows navigate history
- ✓ Duplicates are removed and moved to end
- ✓ Limited to last 1000 entries
- ✓ Empty inputs are ignored
