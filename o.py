import time

print("Welcome Enter 1 to start")
a = input("-->")

if a == "1":
    b = "#"
    increasing = True
    indent = 0

    while True:
        print(" " * indent + b)
        time.sleep(0.05)  # Adds a slight delay so it doesn't print too fast

        if increasing:
            indent += 1
            if indent == 50:
                increasing = False
        else:
            indent -= 1
            if indent == 0:
                increasing = True
